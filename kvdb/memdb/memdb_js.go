//go:build js && wasm
// +build js,wasm

package memdb

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"
	"syscall/js"
	"time"

	"github.com/btcsuite/btcwallet/walletdb"
)

const dbType = "bdb"

type sharedDB struct {
	mu   sync.RWMutex
	root *bucketData
	path string
}

type db struct {
	shared   *sharedDB
	readOnly bool

	mu     sync.RWMutex
	closed bool
}

type tx struct {
	db       *db
	root     *bucketData
	writable bool

	mu       sync.RWMutex
	closed   bool
	onCommit []func()
}

type bucketData struct {
	sequence uint64
	values   map[string][]byte
	buckets  map[string]*bucketData
}

type persistedBucket struct {
	Sequence uint64                      `json:"sequence"`
	Values   map[string]string           `json:"values,omitempty"`
	Buckets  map[string]*persistedBucket `json:"buckets,omitempty"`
}

type readBucket struct {
	tx     *tx
	bucket *bucketData
}

type readWriteBucket struct {
	*readBucket
}

type cursorEntry struct {
	key      []byte
	value    []byte
	isBucket bool
}

type readCursor struct {
	bucket  *readBucket
	entries []cursorEntry
	index   int
}

type readWriteCursor struct {
	*readCursor
	bucket *readWriteBucket
}

var (
	registryMu sync.Mutex
	registry   = make(map[string]*sharedDB)
)

var _ walletdb.DB = (*db)(nil)
var _ walletdb.BatchDB = (*db)(nil)
var _ walletdb.ReadTx = (*tx)(nil)
var _ walletdb.ReadWriteTx = (*tx)(nil)
var _ walletdb.ReadBucket = (*readBucket)(nil)
var _ walletdb.ReadWriteBucket = (*readWriteBucket)(nil)
var _ walletdb.ReadCursor = (*readCursor)(nil)
var _ walletdb.ReadWriteCursor = (*readWriteCursor)(nil)

func newBucketData() *bucketData {
	return &bucketData{
		values:  make(map[string][]byte),
		buckets: make(map[string]*bucketData),
	}
}

func (b *bucketData) clone() *bucketData {
	if b == nil {
		return nil
	}

	clone := &bucketData{
		sequence: b.sequence,
		values:   make(map[string][]byte, len(b.values)),
		buckets:  make(map[string]*bucketData, len(b.buckets)),
	}

	for k, v := range b.values {
		clone.values[k] = cloneBytes(v)
	}
	for k, child := range b.buckets {
		clone.buckets[k] = child.clone()
	}

	return clone
}

func cloneBytes(v []byte) []byte {
	if v == nil {
		return nil
	}

	out := make([]byte, len(v))
	copy(out, v)
	return out
}

func parseArgs(funcName string, args ...interface{}) (string, bool, time.Duration, bool, error) {
	if len(args) != 4 {
		return "", false, 0, false, fmt.Errorf("invalid arguments to %s.%s -- expected database path, no-freelist-sync, timeout option and read-only flag", dbType, funcName)
	}

	dbPath, ok := args[0].(string)
	if !ok {
		return "", false, 0, false, fmt.Errorf("first argument to %s.%s is invalid -- expected database path string", dbType, funcName)
	}
	noFreelistSync, ok := args[1].(bool)
	if !ok {
		return "", false, 0, false, fmt.Errorf("second argument to %s.%s is invalid -- expected no-freelist-sync bool", dbType, funcName)
	}
	timeout, ok := args[2].(time.Duration)
	if !ok {
		return "", false, 0, false, fmt.Errorf("third argument to %s.%s is invalid -- expected timeout time.Duration", dbType, funcName)
	}
	readOnly, ok := args[3].(bool)
	if !ok {
		return "", false, 0, false, fmt.Errorf("fourth argument to %s.%s is invalid -- expected read-only bool", dbType, funcName)
	}

	return dbPath, noFreelistSync, timeout, readOnly, nil
}

func openSharedDB(path string, create, readOnly bool) (*db, error) {
	registryMu.Lock()
	defer registryMu.Unlock()

	shared, ok := registry[path]
	if ok {
		if create {
			return nil, walletdb.ErrDbExists
		}

		return &db{
			shared:   shared,
			readOnly: readOnly,
		}, nil
	}

	root, persisted, err := loadPersistedRoot(path)
	if err != nil {
		return nil, err
	}

	switch {
	case create && persisted:
		return nil, walletdb.ErrDbExists

	case !create && !persisted:
		return nil, walletdb.ErrDbDoesNotExist

	case !persisted:
		shared = &sharedDB{
			root: newBucketData(),
			path: path,
		}

	default:
		shared = &sharedDB{
			root: root,
			path: path,
		}
	}

	registry[path] = shared

	return &db{
		shared:   shared,
		readOnly: readOnly,
	}, nil
}

func createDBDriver(args ...interface{}) (walletdb.DB, error) {
	path, _, _, readOnly, err := parseArgs("Create", args...)
	if err != nil {
		return nil, err
	}

	return openSharedDB(path, true, readOnly)
}

func openDBDriver(args ...interface{}) (walletdb.DB, error) {
	path, _, _, readOnly, err := parseArgs("Open", args...)
	if err != nil {
		return nil, err
	}

	return openSharedDB(path, false, readOnly)
}

func (d *db) ensureOpen() error {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if d.closed {
		return walletdb.ErrDbNotOpen
	}

	return nil
}

func (d *db) BeginReadTx() (walletdb.ReadTx, error) {
	if err := d.ensureOpen(); err != nil {
		return nil, err
	}

	d.shared.mu.RLock()
	return &tx{
		db:   d,
		root: d.shared.root,
	}, nil
}

func (d *db) BeginReadWriteTx() (walletdb.ReadWriteTx, error) {
	if err := d.ensureOpen(); err != nil {
		return nil, err
	}
	if d.readOnly {
		return nil, walletdb.ErrTxNotWritable
	}

	d.shared.mu.Lock()
	return &tx{
		db:       d,
		root:     d.shared.root.clone(),
		writable: true,
	}, nil
}

func (d *db) Copy(w io.Writer) error {
	if err := d.ensureOpen(); err != nil {
		return err
	}

	tx, err := d.BeginReadTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = io.WriteString(w, d.PrintStats())
	return err
}

func (d *db) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.closed = true
	return nil
}

func (d *db) PrintStats() string {
	if d.shared == nil || d.shared.root == nil {
		return "memdb(empty)"
	}

	d.shared.mu.RLock()
	defer d.shared.mu.RUnlock()

	return fmt.Sprintf(
		"memdb(path=%s,buckets=%d,values=%d)",
		d.shared.path, countBuckets(d.shared.root), countValues(d.shared.root),
	)
}

func countBuckets(b *bucketData) int {
	total := len(b.buckets)
	for _, child := range b.buckets {
		total += countBuckets(child)
	}
	return total
}

func countValues(b *bucketData) int {
	total := len(b.values)
	for _, child := range b.buckets {
		total += countValues(child)
	}
	return total
}

func (d *db) View(f func(tx walletdb.ReadTx) error, reset func()) error {
	if reset != nil {
		reset()
	}

	tx, err := d.BeginReadTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	return f(tx)
}

func (d *db) Update(f func(tx walletdb.ReadWriteTx) error, reset func()) error {
	if reset != nil {
		reset()
	}

	tx, err := d.BeginReadWriteTx()
	if err != nil {
		return err
	}

	if err := f(tx); err != nil {
		_ = tx.Rollback()
		return err
	}

	return tx.Commit()
}

func (d *db) Batch(f func(tx walletdb.ReadWriteTx) error) error {
	return d.Update(f, func() {})
}

func (tx *tx) ensureOpen() error {
	tx.mu.RLock()
	defer tx.mu.RUnlock()

	if tx.closed {
		return walletdb.ErrTxClosed
	}

	return nil
}

func (tx *tx) RootBucket() walletdb.ReadBucket {
	if err := tx.ensureOpen(); err != nil {
		return nil
	}

	return &readBucket{
		tx:     tx,
		bucket: tx.root,
	}
}

func (tx *tx) ReadBucket(key []byte) walletdb.ReadBucket {
	if err := tx.ensureOpen(); err != nil {
		return nil
	}

	bucket := tx.root.buckets[string(key)]
	if bucket == nil {
		return nil
	}

	return &readBucket{
		tx:     tx,
		bucket: bucket,
	}
}

func (tx *tx) ForEachBucket(fn func(key []byte) error) error {
	if err := tx.ensureOpen(); err != nil {
		return err
	}

	keys := sortedBucketKeys(tx.root)
	for _, key := range keys {
		if err := fn([]byte(key)); err != nil {
			return err
		}
	}

	return nil
}

func (tx *tx) Rollback() error {
	tx.mu.Lock()
	defer tx.mu.Unlock()

	if tx.closed {
		return walletdb.ErrTxClosed
	}

	tx.closed = true
	if tx.writable {
		tx.db.shared.mu.Unlock()
	} else {
		tx.db.shared.mu.RUnlock()
	}

	return nil
}

func (tx *tx) ReadWriteBucket(key []byte) walletdb.ReadWriteBucket {
	if !tx.writable || tx.ensureOpen() != nil {
		return nil
	}

	bucket := tx.root.buckets[string(key)]
	if bucket == nil {
		return nil
	}

	return &readWriteBucket{
		readBucket: &readBucket{
			tx:     tx,
			bucket: bucket,
		},
	}
}

func (tx *tx) CreateTopLevelBucket(key []byte) (walletdb.ReadWriteBucket, error) {
	if err := tx.ensureWritable(); err != nil {
		return nil, err
	}

	if existing := tx.ReadWriteBucket(key); existing != nil {
		return existing, nil
	}

	return createBucket(tx.root, key, tx)
}

func (tx *tx) DeleteTopLevelBucket(key []byte) error {
	if err := tx.ensureWritable(); err != nil {
		return err
	}

	return deleteBucket(tx.root, key)
}

func (tx *tx) Commit() error {
	if err := tx.ensureWritable(); err != nil {
		return err
	}

	tx.mu.Lock()
	if tx.closed {
		tx.mu.Unlock()
		return walletdb.ErrTxClosed
	}

	snapshot := tx.root.clone()
	path := tx.db.shared.path
	tx.db.shared.root = tx.root
	callbacks := append([]func(){}, tx.onCommit...)
	tx.closed = true
	tx.mu.Unlock()

	tx.db.shared.mu.Unlock()

	if err := persistRoot(path, snapshot); err != nil {
		return err
	}

	for _, callback := range callbacks {
		callback()
	}

	return nil
}

func (tx *tx) OnCommit(fn func()) {
	if fn == nil {
		return
	}

	tx.mu.Lock()
	defer tx.mu.Unlock()

	if tx.closed {
		return
	}

	tx.onCommit = append(tx.onCommit, fn)
}

func (tx *tx) ensureWritable() error {
	if err := tx.ensureOpen(); err != nil {
		return err
	}
	if !tx.writable {
		return walletdb.ErrTxNotWritable
	}
	return nil
}

func (b *readBucket) NestedReadBucket(key []byte) walletdb.ReadBucket {
	if b == nil || b.tx.ensureOpen() != nil {
		return nil
	}

	child := b.bucket.buckets[string(key)]
	if child == nil {
		return nil
	}

	return &readBucket{
		tx:     b.tx,
		bucket: child,
	}
}

func (b *readBucket) ForEach(fn func(k, v []byte) error) error {
	if b == nil || b.tx.ensureOpen() != nil {
		return walletdb.ErrTxClosed
	}

	for _, entry := range cursorEntries(b.bucket) {
		if err := fn(cloneBytes(entry.key), cloneBytes(entry.value)); err != nil {
			return err
		}
	}

	return nil
}

func (b *readBucket) ForAll(fn func(k, v []byte) error) error {
	return b.ForEach(fn)
}

func (b *readBucket) Prefetch(paths ...[]string) {}

func (b *readBucket) Get(key []byte) []byte {
	if b == nil || b.tx.ensureOpen() != nil {
		return nil
	}

	return b.bucket.values[string(key)]
}

func (b *readBucket) ReadCursor() walletdb.ReadCursor {
	return &readCursor{
		bucket:  b,
		entries: cursorEntries(b.bucket),
		index:   -1,
	}
}

func (b *readBucket) Sequence() uint64 {
	if b == nil || b.tx.ensureOpen() != nil {
		return 0
	}

	return b.bucket.sequence
}

func (b *readWriteBucket) NestedReadWriteBucket(key []byte) walletdb.ReadWriteBucket {
	child := b.bucket.buckets[string(key)]
	if child == nil {
		return nil
	}

	return &readWriteBucket{
		readBucket: &readBucket{
			tx:     b.tx,
			bucket: child,
		},
	}
}

func (b *readWriteBucket) CreateBucket(key []byte) (walletdb.ReadWriteBucket, error) {
	if err := b.tx.ensureWritable(); err != nil {
		return nil, err
	}

	return createBucket(b.bucket, key, b.tx)
}

func (b *readWriteBucket) CreateBucketIfNotExists(key []byte) (walletdb.ReadWriteBucket, error) {
	if err := b.tx.ensureWritable(); err != nil {
		return nil, err
	}

	if existing := b.NestedReadWriteBucket(key); existing != nil {
		return existing, nil
	}

	return createBucket(b.bucket, key, b.tx)
}

func (b *readWriteBucket) DeleteNestedBucket(key []byte) error {
	if err := b.tx.ensureWritable(); err != nil {
		return err
	}

	return deleteBucket(b.bucket, key)
}

func (b *readWriteBucket) Put(key, value []byte) error {
	if err := b.tx.ensureWritable(); err != nil {
		return err
	}
	if len(key) == 0 {
		return walletdb.ErrKeyRequired
	}
	if _, ok := b.bucket.buckets[string(key)]; ok {
		return walletdb.ErrIncompatibleValue
	}

	b.bucket.values[string(key)] = cloneBytes(value)
	return nil
}

func (b *readWriteBucket) Delete(key []byte) error {
	if err := b.tx.ensureWritable(); err != nil {
		return err
	}

	if _, ok := b.bucket.buckets[string(key)]; ok {
		return walletdb.ErrIncompatibleValue
	}

	delete(b.bucket.values, string(key))
	return nil
}

func (b *readWriteBucket) ReadWriteCursor() walletdb.ReadWriteCursor {
	return &readWriteCursor{
		readCursor: &readCursor{
			bucket:  b.readBucket,
			entries: cursorEntries(b.bucket),
			index:   -1,
		},
		bucket: b,
	}
}

func (b *readWriteBucket) Tx() walletdb.ReadWriteTx {
	return b.tx
}

func (b *readWriteBucket) NextSequence() (uint64, error) {
	if err := b.tx.ensureWritable(); err != nil {
		return 0, err
	}

	b.bucket.sequence++
	return b.bucket.sequence, nil
}

func (b *readWriteBucket) SetSequence(v uint64) error {
	if err := b.tx.ensureWritable(); err != nil {
		return err
	}

	b.bucket.sequence = v
	return nil
}

func createBucket(parent *bucketData, key []byte, tx *tx) (walletdb.ReadWriteBucket, error) {
	if len(key) == 0 {
		return nil, walletdb.ErrBucketNameRequired
	}

	name := string(key)
	if _, ok := parent.values[name]; ok {
		return nil, walletdb.ErrIncompatibleValue
	}
	if _, ok := parent.buckets[name]; ok {
		return nil, walletdb.ErrBucketExists
	}

	child := newBucketData()
	parent.buckets[name] = child

	return &readWriteBucket{
		readBucket: &readBucket{
			tx:     tx,
			bucket: child,
		},
	}, nil
}

func deleteBucket(parent *bucketData, key []byte) error {
	if len(key) == 0 {
		return walletdb.ErrBucketNameRequired
	}

	name := string(key)
	if _, ok := parent.values[name]; ok {
		return walletdb.ErrIncompatibleValue
	}
	if _, ok := parent.buckets[name]; !ok {
		return walletdb.ErrBucketNotFound
	}

	delete(parent.buckets, name)
	return nil
}

func cursorEntries(bucket *bucketData) []cursorEntry {
	entries := make([]cursorEntry, 0, len(bucket.values)+len(bucket.buckets))
	for key, value := range bucket.values {
		entries = append(entries, cursorEntry{
			key:   []byte(key),
			value: value,
		})
	}
	for key := range bucket.buckets {
		entries = append(entries, cursorEntry{
			key:      []byte(key),
			isBucket: true,
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return bytes.Compare(entries[i].key, entries[j].key) < 0
	})

	return entries
}

func sortedBucketKeys(bucket *bucketData) []string {
	keys := make([]string, 0, len(bucket.buckets))
	for key := range bucket.buckets {
		keys = append(keys, key)
	}

	sort.Slice(keys, func(i, j int) bool {
		return bytes.Compare([]byte(keys[i]), []byte(keys[j])) < 0
	})

	return keys
}

func (c *readCursor) First() ([]byte, []byte) {
	return c.position(0)
}

func (c *readCursor) Last() ([]byte, []byte) {
	if len(c.entries) == 0 {
		c.index = -1
		return nil, nil
	}

	return c.position(len(c.entries) - 1)
}

func (c *readCursor) Next() ([]byte, []byte) {
	return c.position(c.index + 1)
}

func (c *readCursor) Prev() ([]byte, []byte) {
	if len(c.entries) == 0 {
		c.index = -1
		return nil, nil
	}

	if c.index < 0 {
		return c.position(len(c.entries) - 1)
	}

	return c.position(c.index - 1)
}

func (c *readCursor) Seek(seek []byte) ([]byte, []byte) {
	idx := sort.Search(len(c.entries), func(i int) bool {
		return bytes.Compare(c.entries[i].key, seek) >= 0
	})

	return c.position(idx)
}

func (c *readCursor) position(idx int) ([]byte, []byte) {
	if idx < 0 || idx >= len(c.entries) {
		c.index = -1
		return nil, nil
	}

	c.index = idx
	entry := c.entries[idx]
	return cloneBytes(entry.key), cloneBytes(entry.value)
}

func (c *readWriteCursor) Delete() error {
	if err := c.bucket.tx.ensureWritable(); err != nil {
		return err
	}
	if c.index < 0 || c.index >= len(c.entries) {
		return nil
	}

	entry := c.entries[c.index]
	if entry.isBucket {
		return walletdb.ErrIncompatibleValue
	}

	delete(c.bucket.bucket.values, string(entry.key))
	c.entries = append(c.entries[:c.index], c.entries[c.index+1:]...)
	c.index--
	return nil
}

func storageKey(path string) string {
	return path
}

type promiseResult struct {
	value js.Value
	err   error
}

func loadPersistedRoot(path string) (*bucketData, bool, error) {
	readFn := js.Global().Get("__lndWasmDBStoreRead")
	if !readFn.Truthy() {
		return nil, false, nil
	}

	raw, err := awaitPromise(readFn.Invoke(storageKey(path)))
	if err != nil {
		return nil, false, fmt.Errorf("unable to read persisted memdb %s: %w", path, err)
	}
	if raw.IsNull() || raw.IsUndefined() {
		return nil, false, nil
	}

	var bucket persistedBucket
	if err := json.Unmarshal([]byte(raw.String()), &bucket); err != nil {
		return nil, false, fmt.Errorf("unable to decode persisted memdb %s: %w", path, err)
	}

	return restoreBucket(&bucket)
}

func persistRoot(path string, root *bucketData) error {
	writeFn := js.Global().Get("__lndWasmDBStoreWrite")
	if !writeFn.Truthy() {
		return nil
	}

	payload, err := json.Marshal(serializeBucket(root))
	if err != nil {
		return fmt.Errorf("unable to encode persisted memdb %s: %w", path, err)
	}

	if _, err := awaitPromise(writeFn.Invoke(storageKey(path), string(payload))); err != nil {
		return fmt.Errorf("unable to persist memdb %s: %w", path, err)
	}

	return nil
}

func awaitPromise(value js.Value) (js.Value, error) {
	if !value.Truthy() {
		return js.Undefined(), nil
	}

	resultChan := make(chan promiseResult, 1)
	var (
		thenFunc  js.Func
		catchFunc js.Func
	)

	thenFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		res := js.Undefined()
		if len(args) > 0 {
			res = args[0]
		}
		resultChan <- promiseResult{value: res}
		return nil
	})

	catchFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		err := errors.New("promise rejected")
		if len(args) > 0 {
			err = errors.New(args[0].String())
		}
		resultChan <- promiseResult{err: err}
		return nil
	})

	value.Call("then", thenFunc).Call("catch", catchFunc)
	result := <-resultChan
	thenFunc.Release()
	catchFunc.Release()

	return result.value, result.err
}

func serializeBucket(bucket *bucketData) *persistedBucket {
	if bucket == nil {
		return nil
	}

	out := &persistedBucket{
		Sequence: bucket.sequence,
	}

	if len(bucket.values) > 0 {
		out.Values = make(map[string]string, len(bucket.values))
		for key, value := range bucket.values {
			out.Values[key] = base64.StdEncoding.EncodeToString(value)
		}
	}

	if len(bucket.buckets) > 0 {
		out.Buckets = make(map[string]*persistedBucket, len(bucket.buckets))
		for key, child := range bucket.buckets {
			out.Buckets[key] = serializeBucket(child)
		}
	}

	return out
}

func restoreBucket(bucket *persistedBucket) (*bucketData, bool, error) {
	if bucket == nil {
		return nil, false, nil
	}

	out := &bucketData{
		sequence: bucket.Sequence,
		values:   make(map[string][]byte, len(bucket.Values)),
		buckets:  make(map[string]*bucketData, len(bucket.Buckets)),
	}

	for key, value := range bucket.Values {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, false, fmt.Errorf("unable to decode persisted value for %s: %w", key, err)
		}
		out.values[key] = decoded
	}

	for key, child := range bucket.Buckets {
		restored, _, err := restoreBucket(child)
		if err != nil {
			return nil, false, err
		}
		out.buckets[key] = restored
	}

	return out, true, nil
}

func init() {
	driver := walletdb.Driver{
		DbType: dbType,
		Create: createDBDriver,
		Open:   openDBDriver,
	}
	if err := walletdb.RegisterDriver(driver); err != nil {
		panic(fmt.Sprintf("failed to register database driver '%s': %v", dbType, err))
	}
}
