package lncfg

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/btcsuite/btclog/v2"
	"github.com/lightningnetwork/lnd/channeldb"
	graphdb "github.com/lightningnetwork/lnd/graph/db"
	"github.com/lightningnetwork/lnd/kvdb"
	"github.com/stretchr/testify/require"
)

func TestBoltBackendDefaultGraphDBNameUsesChannelDB(t *testing.T) {
	t.Parallel()

	dbCfg := DefaultDB()

	chanDBPath := t.TempDir()
	walletDBPath := t.TempDir()
	towerServerDBPath := t.TempDir()

	backends, err := dbCfg.GetBackends(
		context.Background(), chanDBPath, walletDBPath,
		towerServerDBPath, false, false, btclog.Disabled,
	)
	require.NoError(t, err)

	t.Cleanup(func() {
		for _, closeFunc := range backends.CloseFuncs {
			require.NoError(t, closeFunc())
		}
	})

	require.FileExists(t, filepath.Join(chanDBPath, ChannelDBName))
	require.NoFileExists(t, filepath.Join(chanDBPath, GraphDBName))

	_, err = channeldb.CreateWithBackend(backends.ChanStateDB)
	require.NoError(t, err)

	graphStore, err := graphdb.NewKVStore(backends.GraphDB)
	require.NoError(t, err)

	_, err = graphdb.NewChannelGraph(graphStore)
	require.NoError(t, err)

	assertTopLevelBucketExists(t, backends.ChanStateDB, "metadata")
	assertTopLevelBucketExists(t, backends.GraphDB, "metadata")

	assertTopLevelBucketExists(t, backends.GraphDB, "graph-node")
	assertTopLevelBucketExists(t, backends.ChanStateDB, "graph-node")

	err = kvdb.Update(backends.ChanStateDB, func(tx kvdb.RwTx) error {
		_, err := tx.CreateTopLevelBucket([]byte("missioncontrol-results"))
		return err
	}, func() {})
	require.NoError(t, err)

	assertTopLevelBucketExists(
		t, backends.ChanStateDB, "missioncontrol-results",
	)
	assertTopLevelBucketExists(
		t, backends.GraphDB, "missioncontrol-results",
	)
}

func TestBoltBackendCustomGraphDBName(t *testing.T) {
	t.Parallel()

	dbCfg := DefaultDB()
	dbCfg.Bolt.GraphDBName = GraphDBName

	chanDBPath := t.TempDir()
	walletDBPath := t.TempDir()
	towerServerDBPath := t.TempDir()

	backends, err := dbCfg.GetBackends(
		context.Background(), chanDBPath, walletDBPath,
		towerServerDBPath, false, false, btclog.Disabled,
	)
	require.NoError(t, err)

	t.Cleanup(func() {
		for _, closeFunc := range backends.CloseFuncs {
			require.NoError(t, closeFunc())
		}
	})

	require.FileExists(t, filepath.Join(chanDBPath, ChannelDBName))
	require.FileExists(t, filepath.Join(chanDBPath, GraphDBName))

	_, err = channeldb.CreateWithBackend(backends.ChanStateDB)
	require.NoError(t, err)

	graphStore, err := graphdb.NewKVStore(backends.GraphDB)
	require.NoError(t, err)

	_, err = graphdb.NewChannelGraph(graphStore)
	require.NoError(t, err)

	assertTopLevelBucketExists(t, backends.GraphDB, "graph-node")
	assertTopLevelBucketMissing(t, backends.ChanStateDB, "graph-node")
	assertTopLevelBucketExists(t, backends.ChanStateDB, "metadata")
	assertTopLevelBucketMissing(t, backends.GraphDB, "metadata")
}

func TestBoltBackendGraphDBNameCaseInsensitiveChannelReuse(t *testing.T) {
	t.Parallel()

	dbCfg := DefaultDB()
	dbCfg.Bolt.GraphDBName = "CHANNEL.DB"

	chanDBPath := t.TempDir()
	walletDBPath := t.TempDir()
	towerServerDBPath := t.TempDir()

	channelDBPath := filepath.Join(chanDBPath, ChannelDBName)
	err := os.WriteFile(channelDBPath, nil, 0o600)
	require.NoError(t, err)

	aliasInfo, aliasErr := os.Stat(filepath.Join(chanDBPath, "CHANNEL.DB"))
	channelInfo, channelErr := os.Stat(channelDBPath)
	if aliasErr != nil || channelErr != nil ||
		!os.SameFile(aliasInfo, channelInfo) {

		t.Skip("filesystem is case-sensitive for channel.db alias")
	}

	backends, err := dbCfg.GetBackends(
		context.Background(), chanDBPath, walletDBPath,
		towerServerDBPath, false, false, btclog.Disabled,
	)
	require.NoError(t, err)

	t.Cleanup(func() {
		for _, closeFunc := range backends.CloseFuncs {
			require.NoError(t, closeFunc())
		}
	})

	require.FileExists(t, filepath.Join(chanDBPath, ChannelDBName))
	require.NoFileExists(t, filepath.Join(chanDBPath, GraphDBName))

	_, err = channeldb.CreateWithBackend(backends.ChanStateDB)
	require.NoError(t, err)

	graphStore, err := graphdb.NewKVStore(backends.GraphDB)
	require.NoError(t, err)

	_, err = graphdb.NewChannelGraph(graphStore)
	require.NoError(t, err)

	assertTopLevelBucketExists(t, backends.ChanStateDB, "graph-node")
	assertTopLevelBucketExists(t, backends.GraphDB, "graph-node")
}

func assertTopLevelBucketExists(t *testing.T, db kvdb.Backend, bucket string) {
	t.Helper()

	err := kvdb.View(db, func(tx kvdb.RTx) error {
		require.NotNil(t, tx.ReadBucket([]byte(bucket)))

		return nil
	}, func() {})
	require.NoError(t, err)
}

func assertTopLevelBucketMissing(t *testing.T, db kvdb.Backend, bucket string) {
	t.Helper()

	err := kvdb.View(db, func(tx kvdb.RTx) error {
		require.Nil(t, tx.ReadBucket([]byte(bucket)))

		return nil
	}, func() {})
	require.NoError(t, err)
}

func TestGraphDBStartsFresh(t *testing.T) {
	t.Parallel()

	dbCfg := DefaultDB()
	dbCfg.Bolt.GraphDBName = GraphDBName

	chanDBPath := t.TempDir()
	walletDBPath := t.TempDir()
	towerServerDBPath := t.TempDir()

	backends, err := dbCfg.GetBackends(
		context.Background(), chanDBPath, walletDBPath,
		towerServerDBPath, false, false, btclog.Disabled,
	)
	require.NoError(t, err)

	t.Cleanup(func() {
		for _, closeFunc := range backends.CloseFuncs {
			require.NoError(t, closeFunc())
		}
	})

	graphDBPath := filepath.Join(chanDBPath, GraphDBName)
	_, err = os.Stat(graphDBPath)
	require.NoError(t, err)

	graphStore, err := graphdb.NewKVStore(backends.GraphDB)
	require.NoError(t, err)

	_, err = graphdb.NewChannelGraph(graphStore)
	require.NoError(t, err)

	assertTopLevelBucketExists(t, backends.GraphDB, "graph-node")
	assertTopLevelBucketExists(t, backends.GraphDB, "graph-edge")
	assertTopLevelBucketExists(t, backends.GraphDB, "graph-meta")
}

func TestBoltGraphDBNameValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		graphDBName  string
		expectedText string
	}{
		{
			name:         "path not allowed",
			graphDBName:  ".\\channel.db",
			expectedText: "must be a file name",
		},
		{
			name:         "reserved decayed log db name",
			graphDBName:  DecayedLogDbName,
			expectedText: "reserved bolt DB file",
		},
		{
			name:         "reserved decayed log db name uppercase",
			graphDBName:  "SPHINXREPLAY.DB",
			expectedText: "reserved bolt DB file",
		},
		{
			name:         "reserved tower client db name uppercase",
			graphDBName:  "WTCLIENT.DB",
			expectedText: "reserved bolt DB file",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			dbCfg := DefaultDB()
			dbCfg.Bolt.GraphDBName = test.graphDBName

			err := dbCfg.Validate()
			require.ErrorContains(t, err, test.expectedText)
		})
	}
}
