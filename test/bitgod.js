//
// Tests for BitGoD
// Copyright 2015, BitGo, Inc.  All Rights Reserved.
//

var assert = require('assert');
var should = require('should');
var rpc = require('json-rpc2');
var Q = require('q');
var nock = require('nock');
var pjson = require('../package.json');
var _ = require('lodash');
var results = require('./results');
var bitcoin = require('bitcoinjs-lib');

var BitGoD = require('../src/bitgod');


// Hacky helper function for use in getaddressesbyaccount paging test, only works for pos numbers < 1000
// Original address string was 2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr8

// Creates an array of a specified number of addresses
var createUniqueFakeAddressList = function(numAddrsToGenerate) {
  assert(numAddrsToGenerate >= 0);
  assert(numAddrsToGenerate < 1000);
  var outputAddrList = [];
  var generateUniqueAddr = function(seed) {
    // pad seed value so we always have addr with 35 characters
    if (seed < 10)
      { seed = '00' + seed.toString();
    }
    else if (seed < 100)
      { seed = '0' + seed.toString();
    }
    else {
      seed = seed.toString();
    }

    return "2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXi" + seed;
  };


  for (var i = 1; i < numAddrsToGenerate + 1; i++) {
    var fakeAddr = {
      "chain": 0,
      "index": i,
      "path": "/0/" + i,
      "address": generateUniqueAddr(i)
    };
    outputAddrList.push(fakeAddr);
  }
  return outputAddrList;
};

describe('BitGoD', function() {

  var bitgod;
  var client;
  var callRPC;

  var expectError = function() { assert(false); };

  before(function() {
    // nock.disableNetConnect();
    nock.enableNetConnect('localhost');

    // Setup RPC client and callRPC function
    client = rpc.Client.$create(19332, 'localhost', 'test', 'pass');
    var callQ = Q.nbind(client.call, client);
    callRPC = function(method) {
      return callQ(method, Array.prototype.slice.call(arguments, 1));
    };

    // Setup BitGoD
    bitgod = new BitGoD().setLoggingEnabled(false);
    return bitgod.run('-env test -rpcuser=test -rpcpassword=pass');
  });

  describe('Initialization', function(done) {

    it('basic auth fail', function(done) {
      var badClient = rpc.Client.$create(19332, 'localhost', 'test', 'badpass');
      badClient.call('getinfo', [], function(err, res) {
        err.code.should.equal(-32602);
        err.message.should.equal('Unauthorized');
        done();
      });
    });

    it('getinfo', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/tx/fee?numBlocks=2')
      .reply(200, {"feePerKb":20000,"numBlocks":2});

      return callRPC('getinfo')
      .then(function(result) {
        result.bitgod.should.equal(true);
        result.version.should.equal(pjson.version);
        result.testnet.should.equal(true);
        result.token.should.equal(false);
        result.wallet.should.equal(false);
        result.keychain.should.equal(false);
        result.paytxfee.should.equal(0.0002);
        result.txconfirmtarget.should.equal(2);
      });
    });

    it('not an API', function() {
      return callRPC('wtf')
      .then(expectError, function(err) {
        err.code.should.equal(-32601);
        err.message.should.equal('Unknown RPC call "wtf"');
      });
    });

    it('not implemented', function() {
      var callNext = function(apiList) {
        if (apiList.length === 0) {
          return;
        }
        var api = apiList[0];
        return callRPC(api)
        .then(expectError, function(err) {
          err.code.should.equal(-32601);
          err.message.should.equal('Not implemented');
        })
        .then(function() {
          return callNext(apiList.slice(1));
        });
      };
      return callNext(bitgod.notImplemented);
    });
  });

  describe('Validate address', function(done) {
    it('validateaddress fails on garbage', function() {
      return callRPC('validateaddress', 'foobar')
      .then(function(result) {
        result.should.eql({isvalid: false});
      });
    });

    it('validateaddress fails on prod address', function() {
      return callRPC('validateaddress', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
      .then(function(result) {

        result.should.eql({isvalid: false});
      });
    });

    it('validateaddress succeeds', function() {
      return callRPC('validateaddress', '2N4jxjW3N1XyanRYPkRYJG7CapSepg53tT2')
      .then(function(result) {
        result.isvalid.should.equal(true);
        result.address.should.equal('2N4jxjW3N1XyanRYPkRYJG7CapSepg53tT2');
        result.scriptPubKey.should.equal('a9147e18b65f2ac82c6c4407726e9201d0281068c1b687');
      });
    });
  });

  describe('No auth', function(done) {

    it('getbalance', function() {
      return callRPC('getbalance')
      .then(expectError, function(err) {
        err.code.should.equal(-32603);
        err.message.should.match(/Not connected to BitGo wallet/);
      });
    });

    it('getaddressesbyaccount before setting wallet', function() {
      return callRPC('getaddressesbyaccount')
        .then(expectError, function(err) {
        err.code.should.equal(-32603);
        err.message.should.match(/Not connected to BitGo wallet/);
      });
    });
  });

  describe('Bad auth', function(done) {

    before(function() {
      // logged out state
      nock('https://test.bitgo.com:443')
        .get('/api/v1/user/me')
        .reply(401, {"error":"Authorization required"});
    });

    it('settoken', function() {
      return callRPC('settoken', 'bad')
      .then(expectError, function(err) {
        err.message.should.match(/Authorization required/);
      });
    });

  });

  describe('Good auth', function(done) {

    before(function() {
      nock.cleanAll();
    });

    it('settoken', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/user/me')
        .reply(200, {"user":{"id":"1111111111111111111111111","username":"user@domain.com"}});

      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
        .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81873015758,"balance":81873015758,"pendingApprovals":[]});

      return callRPC('settoken', '1fb45ec431a6edc8df1175e65625ccefa211fef64b726627eea1fea62e1a1ff9')
      .then(function(result) {
        result.should.equal('Authenticated as BitGo user: user@domain.com');
      });
    });

    it('session', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/user/session')
        .reply(200, {"session":{"client":"bitgo","user":"5461addd9b904dac1200003353061409","scope":["user_manage","openid","profile","wallet_create","wallet_manage_all","wallet_approve_all","wallet_spend_all","wallet_edit_all","wallet_view_all"],"expires":"2015-01-30T20:39:06.859Z","origin":"test.bitgo.com"}});

      return callRPC('session')
      .then(function(result) {
        result.client.should.equal('bitgo');
        result.user.should.equal('5461addd9b904dac1200003353061409');
        result.expires.should.equal('2015-01-30T20:39:06.859Z');
        result.origin.should.equal('test.bitgo.com');
      });
    });

    it('setwallet fails on missing wallet', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2NGJUnTv3irhjo8DMWh8arp5ow584CCR7DD')
        .reply(404, {"error":"not found"});

      return callRPC('setwallet', '2NGJUnTv3irhjo8DMWh8arp5ow584CCR7DD')
      .then(expectError, function(err) {
        err.message.should.match(/not found/);
      });
    });

    it('setwallet succeeds', function() {
      return callRPC('setwallet', '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
      .then(function(result) {
        result.should.equal('Set wallet: 2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX');
      });
    });

    it('setkeychain fails for invalid xprv', function() {
      var buf = new Buffer(512 / 8);
      buf.fill(0);
      var xprv = bitcoin.HDNode.fromSeedBuffer(buf).toBase58();
      return callRPC('setkeychain', xprv + 'incorrect-data-makes-xprv-invalid')
      .catch(function(err) {
        err.message.should.equal('Error: Invalid keychain xprv');
      });
    });

    it('setkeychain derives the correct public key', function() {
      // in this test, we're trying to set a keychain to which we don't have
      // the private key. as such, the setkeychain API call actually does not
      // work. However, we still want to test the logic that derives the xpub
      // from the xprv inside handleSetKeychain. As such, we mock up the
      // keychains() call.
      var buf = new Buffer(512 / 8);
      buf.fill(0);
      var bip32 = bitcoin.HDNode.fromSeedBuffer(buf);
      var xprv = bip32.toBase58();
      var xpub = bip32.neutered().toBase58();

      // mock up bitgo.keychains so we don't have to actually get a keychain
      // that exists - just make sure no error is thrown before these methods
      // are called. we need to backup the two values, bitgo and keychain, that
      // are changed when setkeychain is called, and we must return these saved
      // values to the correct values in order to not mess up the other tests.
      var bitgobackup = bitgod.bitgo;
      var keychainbackup = bitgod.keychain;
      bitgod.bitgo = {};
      bitgod.bitgo.keychains = function() {
        return {get: function(params) {
          // this is the xpub corresponding to a 512 bit seed of all 0s
          params.xpub.should.equal('xpub661MyMwAqRbcGbBpWNyiRmuKRQv1bxek4VDxEamwv5eouoLdVB8d8e29h8Y5C9R6maERkgbWZ8wguEZS69bUMzUnhsvkf6s3aabrjMyiT1k');

          return {then: function(f) {
            var keychain = {};
            return Q.all([f(keychain)]);
          }};
        }};
      };

      return callRPC('setkeychain', xprv)
      .then(function(result) {
        result[0].should.equal('Keychain set');
        bitgod.keychain = keychainbackup;
        bitgod.bitgo = bitgobackup;
      })
      .catch(function() {
        bitgod.keychain = keychainbackup;
        bitgod.bitgo = bitgobackup;
        throw new Error('setkeychain failed');
      });
    });

    it('walletpassphrase fails before unlock', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/keychain/xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh', {})
        .reply(401, {"error":"needs unlock","needsOTP":true,"needsUnlock":true});

      return callRPC('walletpassphrase', 'badpass', 300)
      .then(expectError, function(err) {
        err.message.should.match(/needs unlock/);
      });
    });

    it('unlock', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/user/unlock', {"otp":"0000000","duration":600})
        .reply(200, {"session":{"client":"bitgo","user":"5461addd9b904dac1200003353061409","scope":["user_manage","openid","profile","wallet_create","wallet_manage_all","wallet_approve_all","wallet_spend_all","wallet_edit_all","wallet_view_all"],"expires":"2015-01-30T19:33:40.769Z","origin":"test.bitgo.com","unlock":{"time":"2015-01-30T18:56:40.961Z","expires":"2015-01-30T19:06:40.961Z","txCount":0,"txValue":0}}});
      return callRPC('unlock', '0000000')

      .then(function(result) {
        result.should.equal('Unlocked');
      });
    });

    it('walletpassphrase bad password', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/keychain/xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh', {})
        .reply(200, {"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","encryptedXprv":"{\"iv\":\"HybAlQtv1zzR0SILC2+kXw\",\"v\":1,\"iter\":10000,\"ks\":256,\"ts\":64,\"mode\":\"ccm\",\"adata\":\"\",\"cipher\":\"aes\",\"salt\":\"uk4bOcugPhE\",\"ct\":\"gGgjX06ICgv1xwUjKDAJBBgDcTw2IpLaRhxbpbnIiqV5d078iVIdrkzR0NVJn/BALR67rYYzOt9f0v8tQuohpTxePi+WGHeGvXfUxNaq3765akpqnUdHpo9KHVztkCaK4WtwLu2zIW4oxkEGcQgHiF6Yr+QkquQ\"}","path":"m"});

      return callRPC('walletpassphrase', 'badpass', 300)
      .then(expectError, function(err) {
        err.message.should.match(/The wallet passphrase entered was incorrect/);
      });
    });

    it('walletpassphrase success', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/keychain/xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh', {})
        .reply(200, {"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","encryptedXprv":"{\"iv\":\"HybAlQtv1zzR0SILC2+kXw\",\"v\":1,\"iter\":10000,\"ks\":256,\"ts\":64,\"mode\":\"ccm\",\"adata\":\"\",\"cipher\":\"aes\",\"salt\":\"uk4bOcugPhE\",\"ct\":\"gGgjX06ICgv1xwUjKDAJBBgDcTw2IpLaRhxbpbnIiqV5d078iVIdrkzR0NVJn/BALR67rYYzOt9f0v8tQuohpTxePi+WGHeGvXfUxNaq3765akpqnUdHpo9KHVztkCaK4WtwLu2zIW4oxkEGcQgHiF6Yr+QkquQ\"}","path":"m"});

      return callRPC('walletpassphrase', 'sE8zgeeCjoyKMgdjbMzn', 300)
      .then(function(result) {
        assert(result === null);
      });
    });

  });

  describe('Address generation', function(done) {

    before(function() {
      nock.cleanAll();

      // receive address creation
      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/0', {"chain":0})
        .reply(200, {"address":"2N1wzRTkUSkZzDLawha1QZKw5z8smyADzHA","chain":0,"index":26,"path":"/0/26"});

      // receive address creation
      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1})
        .reply(200, {"address":"2MwUPsS6b7tGKDe8ZXNTAhdrQkGmJgozDMg","chain":1,"index":70,"path":"/1/70"});
    });

    it('getnewaddress', function() {
      return callRPC('getnewaddress')
      .then(function(result) {
        result.should.equal('2N1wzRTkUSkZzDLawha1QZKw5z8smyADzHA');
      });
    });

    it('getrawchangeaddress', function() {
      return callRPC('getrawchangeaddress')
      .then(function(result) {
        result.should.equal('2MwUPsS6b7tGKDe8ZXNTAhdrQkGmJgozDMg');
      });
    });

  });

  describe('Wallet info', function(done) {

    before(function() {
      nock.cleanAll();
    });

    it('getinfo', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/tx/fee?numBlocks=2')
      .reply(200, {"feePerKb":20000,"numBlocks":2});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, {"unspents":[ { tx_hash: 'e221a92abd3b446787550d7c34954b76a4fb49f5eb1091bdc9a9adabeed30de5',
        tx_output_n: 0,
        date: '2015-07-07T20:37:18.110Z',
        address: '2MvjLv8oyxrnYdTZ8zmmb1QE8uf16VVi4fZ',
        script: 'a9142639ced1448d394e718ad6f51d4c427f1eb6622b87',
        value: 56547875758,
        blockHeight: -1,
        wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
        redeemScript: '522102598ab55d2be39e124fec05bdcc5150e71363c7c41156c67f9fcdccd88b3961de21033cbe7d4b35f76bf777dd87557d19d06b50c3ec60f13e4dad5029b63b659399102102ee327f905a9eb37ea806172d6432fce61e0fe63c2b2999266d261d188f0a430853ae',
        chainPath: '/1/105',
        isChange: true,
        confirmations: 0 },
        { tx_hash: '15a5690c2b5e5b601dc4ec53d060396e247f7c7aaf73cfdce6bbb0f1aa457ee6',
          tx_output_n: 0,
          date: '2015-07-07T20:40:07.594Z',
          address: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          script: 'a914b238b35dd6399962fbc746f467774c2cf4966a5d87',
          value: 139127071,
          blockHeight: -1,
          wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          redeemScript: '522102e8ff22efc04a4d85e4dc383058eaf163fb93bf847e450c2cdaf893298f1b4c1321034eb5acb9d1134bcee9c211b23282fb67dc29fc4c78c630c89fa5b8c5146fe2a12102e5aecdb7e94c9c7e0dc119daab73504d849e2223cfdda60b395af5558c97806853ae',
          chainPath: '/0/0',
          isChange: null,
          confirmations: 0 } ],"pendingTransactions":false});

      return callRPC('getinfo')
      .then(function(result) {
        result.token.should.equal(true);
        result.wallet.should.equal('2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX');
        result.keychain.should.equal(true);
        result.balance.should.equal(565.47875758);
      });
    });

    it('getwalletinfo', function() {
      nock('https://test.bitgo.com:443')
      .persist()
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
      .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","canSendInstant":true,"label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":71873015758,"balance":81873015758,"unconfirmedReceives":20000,"unconfirmedSends":30000,"pendingApprovals":[]});
      return callRPC('getwalletinfo')
      .then(function(result) {
        result.walletversion.should.equal('bitgo');
        result.balance.should.equal(718.73015758);
        result.cansendinstant.should.equal(true);
        result.unconfirmedbalance.should.equal(100);
      });
    });

    it('getinstantguarantee', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/instant/564ea1fa95f4344c6db00773d1277160')
      .reply(200, {"id":"564ea1fa95f4344c6db00773d1277160","transactionId":"8ba08ef2a745246f309ec4eaff5d7652c4fc01e61eebd9aabc1c58996355acd7","normalizedHash":"62f76eb48d60a1c46cb74ce42063bd9c0816ca5e17877738a824525c9794ceaf","createTime":"2015-11-20T04:30:49.894Z","amount":600000,"guarantee":"BitGo Inc. guarantees the transaction with hash 8ba08ef2a745246f309ec4eaff5d7652c4fc01e61eebd9aabc1c58996355acd7 or normalized hash 62f76eb48d60a1c46cb74ce42063bd9c0816ca5e17877738a824525c9794ceaf for the USD value of 0.00600000 BTC at Fri Nov 20 2015 04:30:49 GMT+0000 (UTC) until confirmed to a depth of 6 confirms.","signature":"1c2ea42ab4b9afdc069441401a1db32334b08aaca6e1a57302540b8c7e0b9da0c933cda2140aa29d73cd8de63418e12222d5e9ff43151ed9df2f27d57854aeb392","state":"closed","confirmedHeight":606424,"confirmedBlock":"00000000006950652a3bf9d3de535a480257d4ada892924f9b09f0d817c18fec","closedByBlock":"00000000007c6465483ab329af80e7b08569c63b5d70d9d7c8fc323755816bc4"}, { 'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-origin': '*',
        'cache-control': 'private, no-cache, no-store, must-revalidate',
        'content-type': 'application/json; charset=utf-8',
        date: 'Sun, 29 Nov 2015 21:55:42 GMT',
        expires: '-1',
        pragma: 'no-cache',
        server: 'nginx/1.6.2',
        'set-cookie':
        [ 'bgAbTest=eyJjaWQiOiJlNDlmN2U3MC1iZjU2LTRiMGUtODk1ZS04ZGM3MjAwNzlhNTAifQ==; path=/',
          'bgAbTest.sig=iOc4OWfRbYrSb__QKveyL_FDSUI; path=/' ],
        'strict-transport-security': 'max-age=31536000',
        vary: 'Accept-Encoding',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'deny',
        'x-xss-protection': '1; mode=block',
        'content-length': '950',
        connection: 'Close' });
      return callRPC('getinstantguarantee', '564ea1fa95f4344c6db00773d1277160')
      .then(function(result) {
        result.amount.should.equal(0.006);
        result.normalizedHash.should.equal('62f76eb48d60a1c46cb74ce42063bd9c0816ca5e17877738a824525c9794ceaf');
        result.signature.should.equal('1c2ea42ab4b9afdc069441401a1db32334b08aaca6e1a57302540b8c7e0b9da0c933cda2140aa29d73cd8de63418e12222d5e9ff43151ed9df2f27d57854aeb392');
        result.guarantee.should.equal('BitGo Inc. guarantees the transaction with hash 8ba08ef2a745246f309ec4eaff5d7652c4fc01e61eebd9aabc1c58996355acd7 or normalized hash 62f76eb48d60a1c46cb74ce42063bd9c0816ca5e17877738a824525c9794ceaf for the USD value of 0.00600000 BTC at Fri Nov 20 2015 04:30:49 GMT+0000 (UTC) until confirmed to a depth of 6 confirms.');
      });
    });

    it('getbalance', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, {"unspents":[ { tx_hash: 'e221a92abd3b446787550d7c34954b76a4fb49f5eb1091bdc9a9adabeed30de5',
        tx_output_n: 0,
        date: '2015-07-07T20:37:18.110Z',
        address: '2MvjLv8oyxrnYdTZ8zmmb1QE8uf16VVi4fZ',
        script: 'a9142639ced1448d394e718ad6f51d4c427f1eb6622b87',
        value: 56547875758,
        blockHeight: -1,
        wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
        redeemScript: '522102598ab55d2be39e124fec05bdcc5150e71363c7c41156c67f9fcdccd88b3961de21033cbe7d4b35f76bf777dd87557d19d06b50c3ec60f13e4dad5029b63b659399102102ee327f905a9eb37ea806172d6432fce61e0fe63c2b2999266d261d188f0a430853ae',
        chainPath: '/1/105',
        isChange: true,
        confirmations: 0 },
        { tx_hash: '15a5690c2b5e5b601dc4ec53d060396e247f7c7aaf73cfdce6bbb0f1aa457ee6',
          tx_output_n: 0,
          date: '2015-07-07T20:40:07.594Z',
          address: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          script: 'a914b238b35dd6399962fbc746f467774c2cf4966a5d87',
          value: 139127071,
          blockHeight: -1,
          wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          redeemScript: '522102e8ff22efc04a4d85e4dc383058eaf163fb93bf847e450c2cdaf893298f1b4c1321034eb5acb9d1134bcee9c211b23282fb67dc29fc4c78c630c89fa5b8c5146fe2a12102e5aecdb7e94c9c7e0dc119daab73504d849e2223cfdda60b395af5558c97806853ae',
          chainPath: '/0/0',
          isChange: null,
          confirmations: 0 } ],"pendingTransactions":false});
      return callRPC('getbalance')
      .then(function(result) {
        result.should.equal(565.47875758);
      });
    });

    it('getunconfirmedbalance', function() {
      return callRPC('getunconfirmedbalance')
      .then(function(result) {
        result.should.equal(100);
      });
    });

    it('listaccounts', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, {"unspents":[ { tx_hash: 'e221a92abd3b446787550d7c34954b76a4fb49f5eb1091bdc9a9adabeed30de5',
        tx_output_n: 0,
        date: '2015-07-07T20:37:18.110Z',
        address: '2MvjLv8oyxrnYdTZ8zmmb1QE8uf16VVi4fZ',
        script: 'a9142639ced1448d394e718ad6f51d4c427f1eb6622b87',
        value: 56547875758,
        blockHeight: -1,
        wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
        redeemScript: '522102598ab55d2be39e124fec05bdcc5150e71363c7c41156c67f9fcdccd88b3961de21033cbe7d4b35f76bf777dd87557d19d06b50c3ec60f13e4dad5029b63b659399102102ee327f905a9eb37ea806172d6432fce61e0fe63c2b2999266d261d188f0a430853ae',
        chainPath: '/1/105',
        isChange: true,
        confirmations: 0 },
        { tx_hash: '15a5690c2b5e5b601dc4ec53d060396e247f7c7aaf73cfdce6bbb0f1aa457ee6',
          tx_output_n: 0,
          date: '2015-07-07T20:40:07.594Z',
          address: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          script: 'a914b238b35dd6399962fbc746f467774c2cf4966a5d87',
          value: 139127071,
          blockHeight: -1,
          wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          redeemScript: '522102e8ff22efc04a4d85e4dc383058eaf163fb93bf847e450c2cdaf893298f1b4c1321034eb5acb9d1134bcee9c211b23282fb67dc29fc4c78c630c89fa5b8c5146fe2a12102e5aecdb7e94c9c7e0dc119daab73504d849e2223cfdda60b395af5558c97806853ae',
          chainPath: '/0/0',
          isChange: null,
          confirmations: 0 } ],"pendingTransactions":false});
      return callRPC('listaccounts')
      .then(function(result) {
        result.should.have.property('');
        result[''].should.equal(565.47875758);
      });
    });
  });

  describe('Unspents', function(done) {

    before(function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
        .reply(200, {"unspents":[{"confirmations":1,"address":"2N2XYoQKXQGUXJUG7AvjA1LAGWzf65RcBHG",instant: true,"tx_hash":"fd426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae","tx_output_n":0,"value":10000000000,"script":"a91465cf7dc1dc237ad59225140773994a747674e42387","redeemScript":"5221021971b4d7c5d919e2655134ac12daa755cd1d6a14996c5b272de24178f3649e952103f8bb35d209e20c1f64f9f2c5686efbcb212a504d3c5ee65e9623187c03009a9321036d051911592ef2a7a72bd53c767d1e57f260c7627a8115d6204d9f33c7dbcc7b53ae","chainPath":"/0/27"},{"confirmations":0,"address":"2N8BJoXnpt9ByzxbxZY5ePrps1vbSmLG6M9",instant: false,"tx_hash":"ed426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae","tx_output_n":1,"value":71873005758,"script":"a914a3cc3df0570bc12afa1fc2202bb6d6e366c1086787","redeemScript":"522102907b7674fad76d9fcfd95914f6ef5bfbb4accd1c27d050451fffd47eca9748b621027b5afd6ad827932a3a541d44e36d596d46cd23f309625739b2a9563f96fae6762102d990d4984d7680242680bc86c1c890fb6a027f30057e5e0f0eeeaed5f6f90bd753ae","chainPath":"/1/72"}],"pendingTransactions":false});
    });

    it('listunspent', function() {
      return callRPC('listunspent')
      .then(function(result) {
        result.should.have.length(1);
        var u = result[0];
        u.txid.should.equal('fd426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae');
        u.vout.should.equal(0);
        u.instant.should.eql(true);
        u.address.should.equal('2N2XYoQKXQGUXJUG7AvjA1LAGWzf65RcBHG');
        u.account.should.equal('');
        u.scriptPubKey.should.equal('a91465cf7dc1dc237ad59225140773994a747674e42387');
        u.redeemScript.should.equal('5221021971b4d7c5d919e2655134ac12daa755cd1d6a14996c5b272de24178f3649e952103f8bb35d209e20c1f64f9f2c5686efbcb212a504d3c5ee65e9623187c03009a9321036d051911592ef2a7a72bd53c767d1e57f260c7627a8115d6204d9f33c7dbcc7b53ae');
        u.amount.should.equal(100);
        u.satoshis.should.equal(10000000000);
        u.confirmations.should.equal(1);
      });
    });

    it('listunspent, min-confirms 0', function() {
      return callRPC('listunspent', 0)
      .then(function(result) {
        result.should.have.length(2);
      });
    });

    it('listunspent, min-confirms 0, max-confirms 0', function() {
      return callRPC('listunspent', 0, 0)
      .then(function(result) {
        result.should.have.length(1);
        var u = result[0];
        u.txid.should.equal('ed426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae');
        u.instant.should.eql(false);
      });
    });


    it('listunspent, min-confirms 1', function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, {"unspents":[ { tx_hash: 'e221a92abd3b446787550d7c34954b76a4fb49f5eb1091bdc9a9adabeed30de5',
        tx_output_n: 0,
        date: '2015-07-07T20:37:18.110Z',
        address: '2MvjLv8oyxrnYdTZ8zmmb1QE8uf16VVi4fZ',
        script: 'a9142639ced1448d394e718ad6f51d4c427f1eb6622b87',
        value: 56547875758,
        blockHeight: -1,
        wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
        redeemScript: '522102598ab55d2be39e124fec05bdcc5150e71363c7c41156c67f9fcdccd88b3961de21033cbe7d4b35f76bf777dd87557d19d06b50c3ec60f13e4dad5029b63b659399102102ee327f905a9eb37ea806172d6432fce61e0fe63c2b2999266d261d188f0a430853ae',
        chainPath: '/1/105',
        isChange: true,
        confirmations: 0 },
        { tx_hash: '15a5690c2b5e5b601dc4ec53d060396e247f7c7aaf73cfdce6bbb0f1aa457ee6',
          tx_output_n: 0,
          date: '2015-07-07T20:40:07.594Z',
          address: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          script: 'a914b238b35dd6399962fbc746f467774c2cf4966a5d87',
          value: 139127071,
          blockHeight: -1,
          wallet: '2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX',
          redeemScript: '522102e8ff22efc04a4d85e4dc383058eaf163fb93bf847e450c2cdaf893298f1b4c1321034eb5acb9d1134bcee9c211b23282fb67dc29fc4c78c630c89fa5b8c5146fe2a12102e5aecdb7e94c9c7e0dc119daab73504d849e2223cfdda60b395af5558c97806853ae',
          chainPath: '/0/0',
          isChange: null,
          confirmations: 1 } ],"pendingTransactions":false});
      return callRPC('listunspent', 1)
      .then(function(result) {
        result.should.have.length(1);
      });
    });
  });

  describe('List transactions', function(done) {

    before(function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500')
        .reply(200, ["1f8b0800000000000203ed9d697762c7b2a6ff4b7db67be53ce81b33cdb4408004f4ea0f3902e2308819ee3affbd23e5630bc9a80ab0745dee755d76b94a25edd2de3cbcf1464664e47f7d5b2fcd6c65dc7a3c9fadbeddfd9ffffa36f6dfeebe7912a5b55c30144374dc581e893491324584a356322928755479a12842d831492c268206ec358e527dfbe59b37eb00572208f35f11f915890ec17748de71f4bf104203f88c18e01330fc06fdf26dbe592f36ebdfbe832dfce6db1d7cd03837dfccd6e92a0d8d7bc7eebeb66c4f62be6eeeddae350a3a6f36a3417dd49def4b4bb8e0d6fc6bf3fb257ffbe7dfbffc7e39fce672f57dec338e1783fe484daa857ac9c68748779967c268d8b9fa43ebf5724208ae94e692ab5fbe8d57f5f10c3eb85e6ec22fdfdcc88c672fd77ef9d5ff9ef9b0ff76a7f9bfffef2fdfc26cbd1c87dfeee8cd8d3c981c6be7ef1b8d59e1204aea582baae1ac3c9cf445ed413757bdd7bff9d7dfee04ff7e279ff03ce01b73f3591c2fa7e63f2fb92498b25fbe2dc2cc8f67c36f77d1fc6b05b766ff35779391598de06ffbfdab8dd24e11153856812286b58a4a591d6d348822813477c651665c50dca5cfe2400c331cbe9551180f47f09d5342b054e9665e3803a82c6528d01810b1c42327acc7420b8cb4e2de111998c28e0acf74c0d163838917d4c333b1f04bfcf99c65a6d5ea94f426c762a3b0b4b8be8b2b9ed9ae577c942bb9fbee7e7c15678d4ca385b78545b34cf0d4dd875e2b5f6b3e148f6260f866f6240a0faf97e32f9ca92b3893ff0d9cddf83c7e32cea896ca198eb0c09170e534c61a444c7a45103714644c32eba38f8a6989390345d31e2b6b04275a1a7f9e3374c7e41dd3b77056df648fc5417f723898ecfc781c11c36335b3d8b58ebbdaa133aa6ec5b9e7fa216642b8f01c426bdabbf7033153d92675f55e76d468d856e6913756af5753f06034ffedbbbc8832f2a9949d83ecc687719e317e19639e82a068c7b0d11cb8408e09eca236c604ce9de7d444129d205e618d8d62123e87624ede33265fb54c236a191005d7d5581b8d18475c732d50608459eabd032d231c734c559098d2e88912247a1ab8a59fcfd87a9079ae3cd6b2b9e9faa9df928f71ed7a7d50d1fa5361abb685fbc1558c65e6d3075163c7716d1f7b4fbdf6a4e466b36967f6bcae57fba5f1289e844ccd18d2e20a29c35f0fd96d4fe327830c1e2b5c298674498481066641a5ac3752e174adc849b4c8c165b40311e5464909af84942e805da3e2d3216b14981db4c7ebee7e7e5f2b0e59573c97274fcb5cefb191d9b6b2f939bf0a325d696632b5d96ad35e9526931dbf9fc7c75cefb9b87b782c05d71ced4f2053ece5695c0e19fd1e6437dfc72790fa9341164d14467a6621cc72d02bc705c55159cba40d116b8684608a394a30435cd8a0204446891c2206336ccf40463b88dd617187d94d90e5b2eb3d5d8d16b879a0cb798f854eaf87fd40066be678517e3ab5513f424c351fe661e6448e97da3bdec9ef4a4af63b0f95d62e2adc63f4c439eb142bc515b1127d8fb01b6fe256bef8f7e8621a5d46577aed8da0ce48298d66117c11d8076e24d3514683b98c982ba2c136214a228d9673821d7e43175684fc4117d6440bc2a214c1222b540075f218aea2b5560a430ec93166f0075445123c02f30737c222d714fe409ff362b883f05d52317a135d74221fdbddc5341e7067b87d2a8f372d915f65f4be5d1c75b3b5fd555eacbedbcaf85c50ed7e9f1cf3448cb753fac8c9a155af156a7ad2a2277152a22461f2720953facbe3e48d4fe30c6494087c1964e0b4690822444139b87fa414531419268024c8f92867c6322ab86751600fa91f7c2448f6d6f063c4f11f90a964c5b4738205cb34135c7b63580c84b198c4cfc3272324c0dc6b0a1f8f3c5a2bb1e1d6058ce16f7e0f19fe95a20e217714dfd11b216bcfb15de9b8a9850cad2f57d952733a31fd7aaff4d89ae1f263e9f5b1a67bf9be86158693466de0ba10e437ab7cb133e08ef563cc3d66e4f09e96ea27cb171227c6ae482b15fb2cc6d27d9c47ec9667718e30852e4d29c123598d29e15c191422f32e7ac90138e911300539a4b0364642e04f21a60aee2cb082de1086387a4d292563040704bc10a2a3d39178169c84d492c2850d089c929a28195d40cac908264c41540682233027cdcf4d587db38c36a7d9633733191c375b512293fb21cd759f2be586dcb275ef344a0aa9e5e55152f1ff01ec02c028b69221f0f55860a141c90c450c2e0171d0d920144a8b6798186589640e6c1e775448e70d8d4a69153f020c0360e426c058ed78d876045beb72af6c1abdda437d336cb0e32113e7bad53a983391e143096393bd781a916367dd160a1f4d35a3d7a439d778428a8a1d62e6f562e4cf17236f2fc617daf6726c31af142c7f6a38bb21d9fda611da33f26c0bebc5fc84d6b498abaea0f5d3d63fe84711f7d647f1975f9bf3c45f9877109bb284c89471802a0a5268ed38406da48b107d31525aca1001764b21c2522791922cbe27fe35ef486f14c820e0c5d1de9a80b00c2470afe12dc3b174d651ce39e3c92006a288e33c80d2464bc051420ac4cf138fef38108fbf5a5231fe51d0ce80156996aad56ca1e8bb6bb20a9dd17c3e75f7ac7fcfdb0bbba99e066d29b0bea2e6a0d0a71943fcd735f5f5599c274c5c4618478e326a8c4012a72561892055888e40d495c1fba8444cc8d1c89908cac1673b10de97d5da3784893f0813dc58aac053f2001a60e0528c521991b28a41e642a3f312071cb9c7d6421602b8c115933785d7431af1731356df86997e72d979b76cf043eb7ea02b07358bb1fdbc53bbeaa0552f9cc8a00219d497cba0d4ff03d8058005cf88f054062e34d64c711b1ce34e40024b79b280d8216d220a1a8c01e4bbd1191724c47441b1e3269c050ca93b4eeff86d4b27a4d79fb7aabd56a9dbab744b32b37dcae05aa6f4788c82dfbb6cb974b680f30114e82d14447ebcca92adcc7bb3c55a670fc7bddd0ffa3c34978b15dedaf6b45612757d2a764a426cbc5cece4e79624ce31c4d0a5c52a1ce15524543a61930913d8387064cc722cc091294169b0100a0578e44880052b884210ccde32444e8a551aec9c0acc30c67cb002a58a8d55409555010788addcf1e8a9897015c385e714fb80e07f9c690752f6678688ee10fac2d04dc6afbe2b3d764a83192f94f3abc1bc5fca129bcff99c65bbdac32a3f50856b8c5fae7fac168f6cd3dad61e3255aef7b9facc2c3bf9ae29986391b6d949adea850c7c3919e2534ba267cb08373d8bb384697de102af07ed8067c0853310b340ac18c814b121f868ad8e284529a968002082f2c64a9e7207f28e304c5fc3a091146094269540adf024d5442368166138680612a5bc30082ecf904bb90d38afe03128a251cc90709e307447d3bf7f3f6105fd342cf2cebc2576192c1f3aeaf0b0a83c6ffd6c537fa86e0f557b4a9806c2c81584897f0e6160602e232c68eb4c101c625dd49e6b0b1926365ed168b491447301626324e2d1596a3065914160d4ef9257ac4f1a3b2812dea54018a8739c1109aa45b95729c846efe08b638000e8107c0a2560b6b8a152452aa2b7f0a96708a31d0c7871f05a37c5c1fc02cb3acb2f5ceccae1eefe49ed478be752b35596fb878715cfe4ae5ae43df696c5495caa5973b45d5740879ff9310ef7c387657f979f8df3f9d3823b07c4d81588b1af5fe4bded699c812c55192eac24500f0838888990b959101e02999c4528e2a062f0d6f364b818925e126282f4c1610471ed1432ac297e5de475491ba5b106bc96a242689e4a118032a7d458f870202852464039697060c20c2700309830c80228139f0f191653b1ab93dc7852bff759d7a9f5e27058211dc3ecb6ef36a5e29f4b3c1fcb989cd79f1622877da9c68ae5052fad483fb0fda4b6c6996eb9b53f9e328680317a05639fb606c73f42eca667f1b311162827e98a204b4ec8b48ac1284ea4b140a53552394720d41a8d030b1c41a648828854518d3448da59c210bda3e28ef3af0e943fac84f2ed51ef8ebbce72b88fdd9eaa093cdcedcd68566eec1e74eba970da35443148fa155504413f11b0bf1a26f977f1a217e2152d812c1052bbc0553404be17ed09f87af0e84a0416e1cfd3926d745e017ae0cb0d43168bf8162fa25ef1d2211204092303e366e173835331595e502f263cc68e5264210d00dc7404e00c0468ae039608525c8fcef93092040cb13b7a5bb608df75bbbfdde07d2bb45bb3c5803d341e06a2e3eefbee793277667e055e42d49f32711d1f8f76dede6597a34af9d03c2e17db512fbb76b578d27003b7784d05417c3701bcf11ebea2cece312297c1a5236404808fb25881838f9a71072f3b33818233c360c49c249e1382490a7b0818108804fd0e2e8c5eeb07cc6b481ab085fc4144f07548336035029b9679ab83e3828392111a987252a6dc119900b90342d2ea33da8545aa1f707447d0577771fcd0e4d7376ed0ca2ddbaccd57f9fdf4a9e59b3db72e179a612dfc782856f76fc40ba2e315aba9027f521f07feac46a18f0913eac24e0eca4570de59e23d258e6a152386b4522b2230e1e0ea43404168efbda1","1e4b1949c45845f9863025e86b2787a03840e813d645acb197162222718483ec819197d4400a6914890089d134f10cfe2b80e5b7ca5b43f179c2f01d527784ff0469e42cb64ca3d46ad9fe5475e934ac69bb5c8cb8726cb9ecb0414e0c0c4bbd2b97eb17d7ff98241214e24205c360801478254f1017227211b5955e5866b9864ccf6227437a4c5e19ef280245a38480e6bde38b9c2818980e4e0c88a84669a103042d84b48eea9903f746b96218886224ad830067dc580dd2e6784056454dcff285f01d26b72d844d97dbd63d61f35028e3e373a3170af7858eb8aff9b869b63bb21faad744c7fcd11debc5876e2b6b494b72f650d39dcc70b2ad30793feadf6f4ef58b4850e5cbf58babaf355f373d8873704975e10ac5cb3fcc0aab52859d382da2724a05e10d365a1b2001439a6d254a6bacdc04941a2ecc3bb838795da17052a3c884b45468055112940d058219e4869611e79883286b050227af3852a0691028816f1f8262ce9c2936629ec48ba13b266e806b86bbeb163e84f18ecb81dd0f2bdbd9ac2ae71d12869b7bfed49d35ae5a6475d37c93cdf551cfee67a3a61cb47ccd356d2bf7d0dae6797679e2bd52dfdd158520cebe58bb6e7b10e7e852979aafdfe8022131d630ee415f04a489c43a84d54be345d2aa881816c412704a1abb007eec5d68e427e68b1948110c843c14c172511ad28a1a443e160d63523247a2a5d1638a7d6a394bbdb63868e11537f03efff38613a08b26f3c5e86d744d8fb3d1c1fb4a876462a9cc26199f593d667ba4385e9352c68c279bab7a3728c995d68b47160e193991bbd270395af6f6bcaaf6c736cde6caa7da4509c5572ce173fac57cddf628cef025905257f08595027a9c5401234c5f7631f9e8289828d02be0450722012c6b25d1928093626f17261444cb3ff8b269b91f3ba384c64884289547e0e581596340bd2c862fa7969997ae6d0e6aa65ca05e3125304028f079be2073a47758bde18b5eba41f3f257465e5765fc4e4745aeb17d62f461db7814f5e3b0d3ce33de9a4ec6eb6ad3af6db17fb2d0cf507aacbfbf949f60ed7f85b731fdcbe65e7e9420dc7c6b7fa2f4e22a8066d45b9e04c801a15a33c2715a36855088ad8846eae88dc7c478eb2da48bca612c3c316f293dad0280df733202f7a9e38a5283a8a4d442d2e0954d8b279a2088a904b4170415e2b892d6427eab0464c106737a9652307054ddb87c76cd0bccc88f7530ec47c761cecdfab9c6fe8873ed696627456d2bcae5e95c6dbb8fa73ac848b2b397eb20f9245019f98c24f4e52a1f66a1825c5a2e0f087b2220674c48a5bd9b2064287a145c48a68b47194c0c4a24b5a290b243d6a0ecbb723956e8740f315c4304ee10414c4b8e8d836c13223849898250a08f364032a0bc361c4854e01d533ba685af81f4349ce99344ba83c0c5913b226f6bb9c0d9351f3cb5863c3c566aa5cd70d827f938291ff6a366d59861f68a2a40fd807bcbb91f572a3494ab935cb17f7cb04d9ded957d93762a3b5a39610c8c2a2557ac73b0efe6a1b7dec65faf249c234ce90b9b7ab432322d9522e25d6434951589562c38031a8921f2c6088203d7d3902f00252a7d9ea56fcae55882d77b6df5f638c0858533c28454a19490eb5348415dda88903203275261dcf3480564a3c16a2691b64034a7e0033f9f30dc5cd79bb8b86d56f63d35ee6ed676b2bf7fb8cf29b177fb5014a36b08dbdebbe6743278ea916cae2a89ef148e74f78c4d8b1e9bd2f543e394300c2a76452d93a3afaf33ddf22c7e32c298b60e540e2224174ac8089947a0282dc61961a9d6012225f3524ac72c8b0ee44fc0e73ad041261517eef3092be430d5e30add75eaa19d63a5f9aa5ae84f17d3d21cccc6245b6c5c53c92c340f92647c6d32ecb87dbf549890dcb25f1ee44ac5ce72bfec0f272784a55882afa864f2efaed5de7a1bffdf69184447637c4c1d3fca43b484c4c0a51d9b02be1ac1c7b9d2101883b34c4478f8103ec1de11903d482e140eea0c61eaa51a20efd04db5f2fa1e7797fd9dea151e0b4aee66abb8af2ffb313c3eadb28bc75ca6d3b9a61ab0ad970a85637637d9769fb7a3eabe6a9f5875d25a9427f76ebb5ffa934d9de045afd8d2c9d4972fd5def420cee1a5d135f928d186588e92e396d86a01a61b08c5f06a4b2e42da4da2b892d410e4ac40926a87dee1855ef3d1183c8204961ba122b0c8a37082a160c0d92b06bce9804cb0d4a4ee34c748a2cf4a0f7ecd1a0ef9063b8b17d67784dda1b7f9a8d6847c6e3a8a3f291bcd950ea3a7de66c0f6b3318ffde106b7769351abcff6f9ceb651e367b6715cd8664b3fd8f8327dc6854e4b54059b4c3afe90e5dd88d5fd70e30a9391c00c24e1e42ec5cb329ffc2c9ee959b59c3e0dc8bebfac39590ddb56e837a68f5d5ed387a7be586db2edfcc09fbc233e484c6ebeab3fbf21d8857b5958a4117b2b98e198091f9123361ae2057e599d231863af59f0412a27a8705c328d257e9b95482a5ef7b2485053e605e2c109a42343262dc328b0865c838a6be9d25b00121fc88314fcf59e6304e989d398456fe9876f08046f885b22fa352fcc8f13df3cdd94cadd36159d633b5f99324bcbddcaa058ecf632d5c372bfdf9eca2d78657a45f1827d5a0f2ff96001f0a647719eaf0be339c691a8b4f0a190331ee00a8e78e51872de69ab88e416a9a03ce790433890381563c42f14bce14b9c4c34d290d36209497364029934e941720e0930002a0de1002da269c73ef0e3244e95b3347206ccbba5eec5299ce14bdd31e0ebed02333c02293f5771c9a728ee743c5ef69bf35533d7cf769ab3e2beef5d65ba2baff4dadf2fabf3c1496aac5309927cd6d23239af5b377c3fef846f0321b13fc9776acfea382c98f553d957969beae30a881b65e8d3bbdd84df01535e06669af26128369431674004d3dc2ba58123e210159c45e38cb101d21017bd0a310dc41204fd49f8f86b2a436de060337d5020a34e29f00210e553a31d89f07f6aace00a739566d8c025bd36da47012e803b4923bb1c4c8a39d33f16be4523f66b71f3244ca3bc2b503d69b7787f78983ffaccb1b9e84dc3e95299a2f4e3d93457580af25b49ed62c23f87cb3ffeda775cddf2084e0b26fdee44b74bb9e3a6b8d40b21179b90d7fbb8e81f1ae12088386916fe155212cd18d7b7bf357efdebef0d7cfefdb92b94c2533b50ac6879b4ce2ffb9cf24ca7540ff3639c1fdb9bce8f2f316dd48ac55a755dcff6d8b016d68bee521c0795696d3ecd364aebb23877899fec1d0a69a5509c616e200279c4e07d19297c05c784eab47529cd5aa4c238458d4ae5038dc0a8308205e718dec567dfa188a7a18b37751d4eb74fdde15e8d733bfdb418648ea5c6a6fc18716fcb5b9bfea1ae1f27d7d426f1f3cab6f8b2c3d706ef8ec755fbe9b07cd8d5db6237accd2ab8d33eb1b057351db2afdef971db7338039704302edcc32d8c0657412485b7824b3b1c954ecdd2d15087c0a818812276e0b1d3cf0a1127ac65ea5dc7b424529c744c63e5bda412dec11e499bc2548c166b44d25a95a0360aa037f5ed7bb0c6243805baaf230ff4a5f9f03c5c2f133db1feea9e30c27e3ca04c94470b90c167b96af15da6dd9d0d72cd3ae507d7ef0f43e5f9b4f49dca5bf48ad237fdb4d68a971bf9ab7d61274fe32c64e2c2d506e5a5b6902e099926057382b9908683a409c204f68a31c87b10f73499626006396a91d7f11d64ec75b5213550a4fe8954244796a6c91bc183305a903e6153fb35a0c54914960153401e92409a0f11c4ce6a747e310bbd4cc17b57fdfe0ac82ed8f9b126054bf4a47f6c4fc739465663daeee67d27cedb8d7bb3793ad1308d054076455d917c5aef21e19f0119ff0164176e9284e0873c4a49930e11a7111f0005244292198d71c0a9d42888f2f0864c7bce14559c0be4f97bc85e374946ab15a4ff69ee30d290ebc710097c154e13aa2c314ab9a0694805379ad60802960a6e4606e42012072c3e822c2999f86ac87e2ffa7e678fe4aacb8bcb67a7f17d7ebe704cec773917a4c8970f9971de9c6c0b67570d0a209f96bec33dfc55bafe780c67d992176efc8014c52a8331e111c3fb2c182fb0708406e93d61f006d42e2d10819c999846091062592a03be67eb75e307e7f0f60632a96656a43630088c90fc6811914fdb4a50f052407ae4b9471aa7c965d2409acf29522c6a64fe56b67ebc1a7f28b2e266532c89d56376fdd42c64439d079729f47a83d5dae6e6c313fd4257c1f5cfd97dfb77e2e5ad75408fe63480d7175e440a69b9001fa6d274ebb432c9d2f637c6013c03060cbe380641b0076174ec5c0efe3225364d59247ff700cffab143dd5cb007bc6b579e9bbba7deb8b79f76779d5e66d83354154e6cb26618a2e315d5c4ef2f11fd44133cc1745fdadcaa8d0367154cd03e520c2fbda504dc36553878ac9cf30e49c6436a6d504800648143baf7b6ad4b82733aa95683a743c6816563283af07704aead038444fa325e51835ca168c09a01d59448ed38fc3619c0b485fc3c5e49bac87b8f7fd924f5feb846bab5c72dc199f6ae3aac3d87c3531fb2d83eab48bdcb9d9aa56bd61df1870b8fc7f17c51ad361e2a621a76cfc57a75d3edf9e85de39e2f4bdddaa47daa110a73fafdbec31baf773b591a9f5ddc58b56b8d28564c13d5ee3e3764f5491ef3e5f1a2651e5ab3ccb8327f33c54792d7fbfa139df4d2d19f3402e50a6cbc709483ab029e2c84bfe82302a1421c525299a6a044876ddacecbbd8a903eb83774a69ddfaf74a6fd255184d46898f66c3aadbdc4ce788529811cd73a82a4e45606210c0b8684800ca1827303a9098ee7e9147794bc8fad97085fb1948dc68987ccaef7909d6caa073d6850b96c55ee3bdb07b2e96f4ee7285e43a7fe00ce19e9d1c7566bb8dccaf848b3cdd2beb892319f19f437f9fb5133f77432425bcbdf762da1cf5a80d4e41c58377e4bef16ef1a8cd7069d2da6b54ed6db0753cdbadeea7e559fe5abfdd276543f5d4154fa7b91995e9a5420e2a81014a8e42aed0b90c1380c06cc47e22c689c03cfcfa8c136a4cc43882819fc44f43b384f920a2b44e03c401a0257603ad5c185c3319db1032198c900c1991001026a9502a9b40672dae03836d804c43e809325e944fa4be1d49f01e774bf6e10d27958dedf57b6629aa57c2859c747953d3e3e37f272527bb32718fdc6d367c1a9cfc3b91b0cb2935da55dcb56aa23ddf058d0dabab8282cf6a5eebeda3d9ea6241c72217286ce9befebcf704a71e97674659174106db10ac2b808e1d673eb19f095762c79ab344005a11e4b08d5001dd046157907277d5dbb234824cde4082432a6c5612495f5ca1bcd03047aa422a30c7eadb18518843501ef685d080c0c6b2a6c9e8113bfc0c9c057dd36b465a78aec50a96756ddf58e2dfc708047b5fe6170249ddc4e67dbf92b32de5ca1b63834db60189bcdfb956e06450a99ce7494b9dfd1756487dc1bdb08def98aa30508fee2a4f7a62771062f852fae3b004a5a2b26c13152067ca523091064a4a9e44035bceecaca347f364dd210017e48f026feedaa1d2432af75070e1ac61cf817aac0240646ac93da4a873c49dbdb3904f1b44d3428903b2118a43ad2a66ec008a64028a33e1faf9cd9914eb7fdec59bb5818962ab5a5e8d61dddefa40e839dce8d2fc7abbe5f97167e3b6fb572b96968e5f9a4b66a568a956d57d5f6a321f64f6ff0","e2945ed1454bbebf17e0b6bbf8cb84fe6478a5017bdc7ba79d964e2b6e15b25a0ab083c460c856343602f043a91f07a7598c4410a5200c7b47b412fe3c5e69eee2ad49ef670ed3c8d87576d02935f3f3fcd3a4b9e77d3e7abc8fddc1f8b9bf9997f0e08d7a119a0a7e97e385fe21e334002f75e989024c3985a31521a8344857480a91ca046e82a2a96ca089b5297cf1188d85a0ce38c658bfc7ebb5e6a04d340cae648132c498f0043303193038390034822dc4e9ac4465a24f0761c0672b030073252d87bfe32d5eec574c7ea5b8936671f33b267f82711af7035773cbae9ff6d6dd901d66d7da0ecb22b20c2e3fd2ca3efb862f0536e572beb0fec78cd350845e384e43529dcec734d4206465eac9d6dc594920d55402074cbd63ced8d40f412c75d1425c4b65fab78441eafb2a609016686007120203de1f14306809a205c297a671f8a08cd03a0845244dfdde60cc587090330b26a354fc2c6148dd617e47c5df3e6c2ab3c9b28735ed8e3b6cf3d038749afb7bc5bb9998d734379fe417d553c0280076c5b029acfe21c3a6146197a69e2c201992abb6d8b1c07504cfe083730843e8c21ae3889d8f51788fa3f412328aa80879e7ee91784d3d9176023b143810644048c1c85b483791b3169eb68064d3484e21f12494a5162d0f1f25c6114421b7a0f2bc80a5765472c76fb35f57ccbdc73fc2abd46be1e146b5e8331d0ed578f4acfbade553b55278a875dba5c5833fc58b6bc4ae2899e2cf1c79f0574f00c0dfc54b5c68bf4cdae28b68c41020754c561c38e3c212eeb850321d8d435e1a3402161e6228265844cac53bbcd8abfdb21c32cf34f9d80796940fa4cf2191ce8a8a3242d0240c6082c049c0e51319354addd6a0694e491389403f375ec5eeb81df2b9e372240bfbd1343f73f87ea3d4a0559c98dd3abf7fa35e5c217645db07feee2cc61befe22f13fab3e195e62f06c30c48964fbdcc1230499d6a912110461238d21ca50a0642d447662d9542a4c377bcc52a8abf152ff2c37efa7d75688a7d5adc0779a83ced8bebb63e4eabb3f920960ff2c14ddfe0050fe68a7e7a2c3e092ff20978919f14af488844463ae64d44e0a750aabf86b4a84b48e432a61e49c6d2904694862223a20387a84cd00b8cef464d7d0a5ed7d862427f34e933544c67be6cd86a635018cd42e571d0572ddbdb15bbedcdd364787a3e0e633479dbcbf9fabc99eb701f67c3e34dcfe227234c401e4a0d6388a4e36d749a97a602a0668507b34f154e23da894ed33628920c7c3fa55e58415c1a09a93f70f7f42eedc1c45f2d603facc91f1e164359586d9e17d9e7a81eab8d6711487b323c9a5c4d6ed62ffb47ff004c20ceae58fdc2e49304eccb9727c8a585a58412381f885882710a961b7445a4057deab0d7861891f64c38e5783afed01ba2b010fcedc12309af57778f8503b71e9d85348007ca8896ce232f198b187bcb502434eded35f0514c84504e1080d7581e5804127f06bc3eeef808ab1a656e37ab2f33a3e96c1e8bcdddd8b7dacb69b770bfad161a6fe94a67ad5c4ed7270e2afeabde9e7f57bafe36b6980c012c7b0405f39c1b230383ac1133aa71e0220dc80e0454cdc0cf424a503508934e0aa2844f47d2898fd84ac1f1cb27c9fe7833a3388cbb0fe59e5cf1a3ab8fd7653fa9cff78b56bdd029e8357f50ec0d5de904b22be8faac49b29f32c4877c7fe94b5eb8f41520688918499a6e4c28714c50aea9f411474325a0c75c248e184ba34b6db251c4747449784fd8ebd297523e1dee4a2876d141fa445301ce841034a641798a9535383511a5d917241dd84153434750815b2ed907ea8513618cfdfd8babab816ad667c58d39cab2db666badbda98e78399fe96e36a5dd7e5c3e254c0161572cde63f40f5a5cbdb4b6ad71c4261825228428a48d30312a04699df33810c8046d604c46c39dd3917312bd03ede1ea1d6127b56d193c383425d23002aa54449ac1776a582a91d35431f24c803ba3e0f452cfb7323c75e1a6ed2a5c09718eb0346a5da76d89ec2738f28656dbd5e6e8795a6e97bdd643f91c7a6bbb1f1f6a3af3f4184ac3fa29611a08bb62f9fe9f33ac18f2b20beb4344a601fdc2e8d4d8409949232eb40e1485d46086b5b0d1a6f9d7311a028ca405505035f156c23851271319c14f61c80eb8000b9f4e38575122ab38c8228449015f2c4910405a3a5e90c6742218f10ef206ec8934e44c90c4aa83f41d857ffffe61d8f5552fe6dcfea1b46b9b0c9916b3d95ceec966f699ce3cb75eefee9fede909abe944aa6b4e9cfee700c62f2d0f459ebc0f28b90f5649a69003a7a50df86d0e6071a582f7c1109f56f1b1d30e9c3ad53abe1db1c2e449798842cc0b8a79ebd3643c67834ecd13126313b524ca33e3412dad06b9249a726031a499f7d182d10bc69d4920114ec7c2517ee3d995f5836e6e26ad5c9199c7e3fdc24ec6c7955d9a4ef3c8bb0b591c3b768d82e517d545b15899f7e69daccef345d3144af372aff2ac5cfd38f5fbd33d033cadae5eb180cfbe1cb09b1ec59f014b8db017b67513ac08b7f09ff1016be3b1625130501309e69c43aa6720c5c3293a1a91863e716b0143f7b6fe88f5c9cc6208ac81ba34aa389521d3447585b0b0160c3ed2d273249d01036c82408240fc3538b585a59352634c4d9b9f0fd8eeb92ef7bb19cbf59dec1965828f4f99d9c43e08d7a9cf3ae1f9aa0a377d685487fe21e37d6180b52a2c5acd43cb1f1787b9f3c3d2b0fa1eb06b86167fbd82ddf2287e32c0d2cc1385ac084a190761356d63915404a1b837c24783140567e2d3d936323887258bd42a1aa30d6926dca703d6a0f345be71acced832bb29765b6d95ad1e1fcb949bd2e13015d3fa9f8f41fbb8ff6ba00bbcbe2a375636238ff5d6b8f1b43f3ed3e164f2d0280dfbcbdc5bbcd2c08bcbcf23f93cbcce9fbc7bfd63f8d9d0629ca57ab807f5f248c5001135a4e321802f974e15178c86b4e9098c1de40a5ea2e802e669a9cc7b1ac3cfa05d1fa3b58da3fcf830a1f3d5e1703fa199fdae631f96e5e3f3ee498daad5a7b7687176c5eabdfc5ab46e790c3f195a60dfac21462a0b7e4ba5ad7269eaa24e474ff0206c3aeb8678ea522ea9c1722109cae6d2e97096622046bf470b2763ff9f495ef4cb379bfff824cbd9f338968fca14c6a2380935bb1e4e87eab8b4ca4f0ae3d578710a57f25c57acadd22f9ee475e3a3380318275a5e33cbdf6286456a72488d3316323e78f985c1c805c7d311219210970ea8893612124c546f00431a617e72562a7c65082e488948ead0872ba8d4dec3522d1298815cd4e874fcbcd2e97258a1f0db7e3dea7940ee2c6004a5b322e84dd30c6e199ef897a72716e6e34aa73c1e6797bb85bf5f0fe7bdecbeff94992e8683239ee4baa77b84fe7360c9674d4dfa68e1eb966fe9763e7ffd11a0172e6d08cb011fc114843a630316587aa08a6229d220a0745eb948ab0e8a0b96fa7318f31026857f0fe8ebd246ea64d5e97c5f4b290a927ba90348a062d4ab0899029624ad79a44987698a9780ec5450091902498501aace00fa32c69f893b76e376e2fb2c3f96caa5a7ce9867bbf558ac0c72aab3ac4efb99da7250dc3d9eb6bcfffee3e3e2656eb95e2d17dd49b14ac77edc7e3844e35da1ba3a342b99c756419c4a602a5c5ed3baff791b43e007fdfd3efefac338c398b89831c80b79dafce670da4b6c9cf54242a843ce381e0873c12bcf880e5e701614f6694fd1fb03a3913a652c8d4324de13095c7248400307350c043055d2306a0053a282221e3380da49af21fdf41a5c9de152bb732248d27c62c2eeb8fadba36c03ef1695d5b6ecf548ae0b23d939e61acb7bf69c1b0fb2e2a1325f744ea5445c779a1cfec7445910a00b8f89007b6611551123a223f55408150de483a901d64aab19885a4c47f85a9d8e74081c2830c2be290020a94fce22410018b8416db592c9233a303308348b094ad3d971a95c0a4849c6581a18e0525c4f33b2834e8361a93d0f184d36eeb612d3e71600f23d966de6437edfe6d5fba7d5d3b6db286e6bcf8565be1d06ad11ef9e02a6ae3bf20bfd53d6671360172a1807e7c6d3222a64168a324939512942820513517a0f82e50d8388e6454cba165d8a6fd6bd07ec55c15e8ee92542d9940e2821298d69ce0697d6694a53964023445fcab5b01a818639e0d0f074b809e4a2ca7ca460a9c244ffdb6cdc274c65ed4cbabbc67db63f9e6dba995a1f172a8571a9ccd661b65d7527a593a3e724f8102585f80a3377663cebe5dfd8efb31bf17740bbb01d2344cc99c51ca5e3b7086336a4331e204b14e9d437c81e2173f008340878d4182c7d48dd3911bf07ed25975aadcdf2b7d7f93f779566b0ade76bf3aff4cb7fff3f19938b64cfa50000"],
        { 'access-control-allow-headers': 'content-type, authorization',
          'content-encoding': 'gzip',
          'content-type': 'application/json; charset=utf-8',
          vary: 'Accept-Encoding',
          'transfer-encoding': 'chunked'
        });

      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&skip=10')
        .reply(200, {"transactions": [], count: 0});
    });

    it('listtransactions', function() {
      return callRPC('listtransactions')
      .then(function(result) {
        result.should.eql(results.txList1);
      });
    });

    it('listtransactions count=20', function() {
      return callRPC('listtransactions', "", 20)
      .then(function(result) {
        result.should.eql(results.txList2);
      });
    });

    it('listtransactions count=5 skip=5', function() {
      return callRPC('listtransactions', "", 5, 5)
      .then(function(result) {
        result.should.eql(results.txList3);
      });
    });
  });



  describe('List since block', function(done) {

    before(function() {
      nock.cleanAll();
    });

    it('listsinceblock', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/block/latest')
      .reply(200, ["1f8b08000000000000034cce4b4e03310c00d0bb783d458ee3389f732021815838764c47482d6a073688bbb361c13bc1fb86dd6100fe99bde5e98b9508979788d6bc4dd3ca896a9b6d6593a56916ae51bb61ac595553870dce6b7f3b1f307267496503d763c100c2544e584e581f8946ee23e7875ae81936b0b3ee97a7ebed1d0654aab93611616929313729021b7cdcd6d77efdbcff2b6a4fcbb36ba04a602bdd0a4a5b16ae54509bd14c4b95ad636209f2299e6b306c70dcf472573bf6ebe50ee305a6387120d71673baf7aee639284d2b6a8c829ac5972956d64a4149b96429c118aac60caf3fbf000000ffff","0300107abe0240010000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500')
      .reply(200, ["1f8b0800000000000203ed9d597762c7b2e7bf4b3ddbbd721ef4c64c332d102001bdfa2147401c0631c35de7bb77a47c6c2119550196aecbbdaecb2e57a9d02e76f2db11ff1832f2bfbead9766b6326e3d9ecf56dfeefecf7f7d1bfb6f77df3c89d25a2e188a213a6e2c8f449a489922c2512b9914943aaabc501421ec982416134103f61a47a9befdf2cd9b75802b1184f9af88fc8a4487e03b24ef38fa5f08a101bc2206780186dfa05fbecd37ebc566fddb3bd8c26fbeddc1178d73f3cd6c9daed2d0b877ecee6bcbf624e6ebe6deed5aa3a0f366331ad447ddf9beb4840b6ecdbf36bf5ff2b77ffefdcbef97c36f2e57dfc73ee37831e88fd4a45aa8976c7c88749779268c869dab3fb45e2f2784e04a692eb9fae5db78551fcfe08bebe526fcf2cd8dcc78f672ed975ffdef990ffb6f779afffbfffef22dccd6cb71f8ed8ededcc883c9b176febed198150ea2a48eb5a21acecac3495fd41e7473d57bfd9b7ffded4ef0ef77f209eb016fcccd6771bc9c9aff7ce4126e99fff26d11667e3c1b7ebb8be65f2bb835fbafb99b8ccc6a047fdbefdf6d94768aa8c0b10a1431ac5554caea68a3411409a4b9338e32e382e22ebd8a0331cc70782ba3301e8ee09d5342b054e9665e3803a82c6528d01810b1c42327acc7420b8cb4e2de111998c28e0acf74c0d163838917d4c39a58f825fe7cce32d36a754a7a9363b151585a5cdfc515cf6cd72b3eca95dc7d773fbe8ab346a6d1c2dbc2a2592678eaee43af95af351f8a4731307c337b128587d7cbf117ced4159cc9ff06ce6e5c8f9f8c33aaa57286232c70245c398db1062326bd22881b0a664c32eba38f8a698939038ba63d56d6084eb434fe3c67e88ec93ba66fe1acbec91e8b83fee47030d9f9f1382286c76a66b16b1d77b5436754dd8a73ebfa216642b8f01c426bdabbf7033153d92675f55e76d468d856e6913756af5753b0309afff62e2fa28c7c2a65e720bb7131ce33262e63cc533028da316c34072e906302bba88d318173e7393591442788575863a39884d750ccc97bc6e4ab2dd3885a0644c17535d64623c611d75c0b141861967aefc096118e39a62a484c69f44409123d0ddcd2cf676c3dc83c571e6bd9dc74fdd46fc9c7b876bd3e58d1fa5361abb685fbc1558c65e6d3075163c7716d1f7b4fbdf6a4e466b36967f6bcae57fba5f1289eb84ccd18d2e20a5386bf1eb2db56e327830c9615ae1443ba24c24003b360a5ac3752e174adc849b4c8c165b40323ca8d92123e09295d00b946c5a743d628303b688fd7ddfdfcbe561cb2ae782e4f9e96b9de6323b36d65f3737e1564bad2cc646ab3d5a6bd2a4d263b7e3f8f8fb9de7371f7f0580aae39da9f40a6d8cb6a5c0e19fd1e6437dfc72790fa9341164d14467a66c1cd72b0578e0b8aa3b296491b22d60c09c11473946086b8b041818b8c1239440c66d89e818c7610bbc3e20eb39b20cb65d77bba1a2d70f34097f31e0b9d5e0ffb810cd6ccf1a2fc742aa37e84986a3eccc3cc891c2fb577bc93df9594ec771e2aad5d54b8c7e88972d6c9578a2b7c25fa1e6137dec4ad7cf1efd12535be8caef4d91b419d91521acd22e822900fdc48a6a38c067319315744836c4294441a2de7043bfc862eac08f9832eac8916844529824556a800d6c963b88ad65a290c3124c798c11f501549f008c41fdc088b5c53f8037d4e8be10ec277c98ad19be8a213f9d8ee2ea6f1803bc3ed5379bc6989fc2aa3f7ede2a89badedafd262f5dd56c6e7826af7fbe4982762bc9dd2474e0ead7aad50d393163df193122513262f37614a7fb99fbc7135ce4046b9209741064a9b862042149483fa474a31459161024882988f72662cd843ee5914d843e8075f0992bd15fc1871fc07642a4931ed9c60c132cd04d7de181603612c26e3e7e1c5080910f79ac2d7238fd64a6cb8750163f89bdf43867fa5a843c81dc577f446c8da736c573a6e6a2143ebcb55b6d49c4e4cbfde2b3db666b8fc587a5dd6742fdfb76185e1a4511bb82e38f9cd2a5fec0cb863fd18738f1939bca7a5fa49fa42e2c4d81561a5629fc558ba8ff388ddb216670863f0995f18528246b21a53c2b9322844e65df4920370d223600a6248616d8c84c09f824f15dc596005bd210c71f41a524ac6080e0878214447a723f12c3809a125850b1b30704a6aa26474012927238830055e19088ec09c343f3761f5cd32da9c668fddcc6470dc6c45894cee8734d77dae941b72cbd6bd532f29a496977b49c5ff07b00b00a3d84a8640d7638185064b6628627009f083ce06a1504a9e6162942592399079dc51219d37342aa555fc08300c80919b0063b5e361db116cadcbbdb269f46a0ff5cdb0c18e874c9ceb56eb60ce78860f4d189becc5d3881c3bebb650f868aa19bd26cdb9c6135254ec1033af17237fbe18797b31bed0b697638b79a560f953c3d90dc9ee378dd09e91675b582fe627b4a664aeba82d64fcb7fd08f3ceead4bf1973f9bf3c45f1877109ba284c89471802a0a5268ed38406da48be07d31525aca1001764bc1c3522791922cbe27fe35ee480f0a4410f0e1686f4d40580612b8d7f0c8702c9d759473ce7812888128e2380f6069a325a0282104e2e789c7771c88c75f6d5231fe91d3ce80146996aad56ca1e8bb6bb20a9dd17c3e75f7ac7fcfdb0bbba99e3a6d29b0bea2e6a0d0a70943fcd76deaeb5a9c274c5e4618478e326a8c4012a794b044102a4447c0ebcae07d542226e468e44c04e5e0d50e0cef4bb6f60d61e20fc20437962ad0943c800d30702946a98c4859c52072a1d17989038edc636b210a01dce08a499bc2e7218df8b909ab6fc34c3fb9ecbc5b36f8a1753fd095839ac5d87edea95d75d0aa174ecca00233a82f378352ff0f601700163c23c25319b8d05833c56d708c3b01012ce549026287b4892868100610ef46675c90e0d305c58e9b701630a4ee38bde3b7a54e48af3f6f557bad52b757e9966466fb94c1b54ce9f11805bf77d972e96c01e70328d05b2888fc38cb92adcc7bb3c55a670fc7bddd0ffa3c34978b15dedaf6b45612757d6aec9404df78b9b1939f5b9238cb10bdb45885237c8a844a276c1261021b078a8c598e05283225280d165ca1008d1c09b0600551089cd95b86c849b14a839c538119c6980f56a054b1b10aa8b22ae000be953b1e3d3511ae62b8f09c621f10fc8f33edc094fd9921a23b84be307493f0abef4a8f9dd260c60be5fc6a30ef97b2c4e6733e67d9aef6b0ca0f54e11ae197eb1fabc523dbb4b6b5874c95eb7dae3e33cb4ebe6b0ae658a46d7652ab7a21035f4e86f8d492e8d932c24d6b718e309696fea204af07db016bc08533e0b3c058313053c486e0a3b53aa2e4a5a4a2018008ca1b2b798a1dc83bc2307d7583465280519a5402b5c29354138d60b308c341333051ca0b83e0f20cb914db80f20a1e8345348a1912ce1386ee68faf7ef27aca09f8645de99b7c42e83e543471d1e1695e7ad9f6dea0fd5eda16a4f09d34018b98230f10f220c5f68c382b6ce04c1c1d745edb9b6106162e3158d461b493417606c8c443c3a4b0da62c32708cfa5df08af549630745c2bbe40803758e3322c16a51ee5572b2d13bf8e618c0013a042fa104c4163754aa4845f4165e7a8630dac1801707ad75931fcc2fb0acb3fcc2c5ae1ceeee9fd47eb4782e355b65b97f7858f14ceeaa24efb1b72c4ee252cd9aa3edba0276f8991fe3703f7c58f677f9d9389f3f2db873408c5d8118fbfa24ef6dab7106320e4fcf859504ea0101073e1122370b8687402467118a38a818bcf53c092e86a4978498207d7018815f3b850c6b8a5f93bc2ed94669ac01ada5a8109aa75204a0cc293516be1c088a9411b09c3438106186130018441844019489cf870c8ba9d8d5496e3ca9dffbacebd47a7138ac908e6176db779b52f1cf259e8fcd989cd79f1622877da9c68ae5052fad483fb0fda4b6c6996eb9b53f9e328680317a05639f9683e31f2176d35afc6c8405ca49ba2298252764ca62308a13692c50698d54ce1170b546e3c0024710299220225554230d26ed2c6188de5171c7f9573bca1f5642f9f6a877c75d6739dcc76e4fd5041eeef666342b37760fbaf55438ed1aa2184cfa155504413f11b0bfea26f977f1a217e2152d81281042bbc0553404de8bf604743d687425028bf0e729651b9d57801ee872c390c522bec58ba857bc74880441c0c840b859786d702a26c90bd68b098fb1a31459080300371d0138030e9aeb802552e05ed1391d46920143ec8ede162dc2bb6ef7b71bbc6f85766bb618b087c6c34074dc7ddf3d4fe6ceccafc04b88fa5326aee3e3d1cedbbbec7254291f9ac7e5623bea65d7ae164f1a6ee016afa92088ef068037dec357d4d93943f432b874940c013eca62050a3e6ac61d7ceccc040aca0c83107392784e0826c9ed2160402012f43bb8307aad1f30af2168c016e2071141d721cd80d5086c5ae6ad0e8e0b0e968cd0c0949332c58ec804881d1092569fb15d58a4fa014777047d7517c70f457e7de306addcb2cdda7c95df4f9f5abed973eb72a119d6c28f876275ffc6788177bc229b2af027f571e0cf6a14fa9830ad2eece4a05c04e79d25de53e2a8563162082bb522","02130eaa3e041484f6de1beab19491448c55946f085382be7672088a03b83e615dc41a7b69c1231247007a0b425e520321a45124022446d3c433e8af0092df2a6f0dc5e709c37748dd11fe138491b3d8328d52ab65fb53d5a5d3b0a6ed7231e2cab1e5b2c3063911302cf5ae5c6ebfb8fec704915ceb0b2d180601a4402b7982b810918ba8adf4c232cb35447a163b19d2327965bca3082c1a25046cde3bbec8890503d1c189e1186994121d60d042487954cf1ca837ca1544b8c43192f220c01937568369733c20aba2a667f942f80e93db1261d3e5b6754fd83c14caf8f8dce885c27da123ee6b3e6e9aed8eec87ea35de317f74c77af1a1dbca5ad2024ff150d39dcc70b2ad30793feadf6f4eed179160952fb75f5c7dadf8ba6921cec02540515e06d7cb3fcc0aab52859d382da2724a05e10d365a1b200143986d254a39566e024a0d17e61d5c9cbc66289cd42832212d155a819704cb8602c10c6243cb8873cc8197b5028192571c29b069e028816f1f8262ce9c2936629e8c1743774cdc00d70c77d72d7c08e31d9703bb1f56b6b35955ce3b240c37f7fca93b6b5c956475d37c93cdf551cfee67a3a61cb47ccd356d2bf7d0dae6797679a2bd52dfdd158520cebed876ddb610e7e8c2978aafdfe8024362ac61dc837d11102612eb10562f8d17c95645c4b020968052d2d805d063ef5c233f115fcc408860c0e5a108928bd290326ae0f958348c49c91c8996468f29f6a9e52cf5dae2a08557dcc073fee70d2740174de28bd1dbe89a1e67a383f7950ec9c452994d323eb37accf64871bc26a58c194f3657f56e50922bad178f2c1c32722277a5e172b4eced7955ed8f6d9acd954f6d1725145f91c2e7f48bf9ba6d29cef14595be822fac14d0e3a40a1861fab28bc94747414481bd025e74485db9ce5a49b424a0a4d8dbc484026ff9075f36a5fbb1334a688c44885279045a1e983506ac97c5f0edd432f3d2b5cdc19a2917a8574ca58782097c9e2f881ce91d566ff8a2976ed0bcfc9391d75519bfd351916b6c9f187dd8361e45fd38ecb4f38cb7a693f1badaf46b5bec9f24fa194acbfafb47f909d2fe57788ce95f16f7f2a300e1e65bfb13a517570134a3def264801c10aa35231ca7b429b8426c453452476f3c26c65b6f215c540e63e189794be9691500f49e9311b84f1d57941a4425a5168206af6c4a9e6882c0a712b0bd6050c18f2b692dc4b74a40146c30a76729050147d58de9b36b3e60467e6c07c37e741ce6dcac9f6bec8f38d79e667652d4b6a25c9eced5b6fb786a07194972f6723b483e0954463e23087db9ca8751a8e09796cb03c29e088819135269ef261832143d0a2e24d1c5a30c26062592b5a210b243d4a0ecbb723956e8740f315c4304ee10414c4b8e8d8368133c3849818250601f6d806040796d3890a8403ba6764c0bdf03e16938d327897407818a237744ded67281b36b3e786a0d7978acd44a9be1b04ff271523eec47cdaa31c3ec155580fa01f796733fae5468285727b962fff8609b3adb2bfb26ed5476b472c21808554aaec873b0efc6a1b7dec65faf249c214c627d61538f5646a6542922de454653599168c5823360233178de18c1e000181ae205a044a5d759faa65c8e2568bdd7566f8f035c5838234c48154a09b13e8510d4a58d082932702215c63d8f5440341aac6612690b44730a3af0f309c3cd75bd898bdb6665df53e3ee666d27fbfb87fb9c127bb70f4531ba86b0edbd6b4e2783a71ec9e6aa92f84ee14877cfd8b4e8b1295d3f344e09c360c5aea86572f4f575a65bd6e227238c69ebc0ca8187e442091921f20814a5649c11966a1dc053322fa574ccb2e8c0fc0978ad033bc8a4e2c27d3e61851ca67a5ca1bb4e3db473ac345f550bfde9625a9a83d898648b8d6b2a9985e641928caf4d861db7ef970a13925bf6cb835ca9d859ee97fde1e48430090b86afa864f2efe66a6fbd8dffef6c187847637c4c1d3fca83b784c0c0a51d9b02be1bc1d7b9d2e01883b34c44587c709f20ef08983d082e140eea0c61eaa51a20efd04db5f2fa1e7797fd9dea151e0b4aee66abb8af2ffb313c3eadb28bc75ca6d3b9a61ab0ad970a85637637d9769fb7a3eabe6a9f5875d25a9427f76ebb5ffa934d9da045afd8d2c9d497a76a6f5a88737811744d3c4ab42196a3a4b825b65a80e8964261f8b4251721ed26515c496a0872562049b543eff042aff1680c1e4100cb8d501158e45138c15030a0ec1503de744026586a52779a6324d167a507bd660d8778839dc50beb3bc2eed0db78546b423e371cc59f148de64a87d1536f3360fbd998c7fe70835bbbc9a8d567fb7c67dba8f133db382e6cb3a51f6c7c993ee342a725aa824d261d7fc8f26ec4ea7eb87185c948600626e1e42ec54b9a4f7e16cff4acb59c3e0dc8bebfac39590ddb56e837a68f5d5ed387a7be586db2edfcc09f3c111f042637dfd59f1f0876e15e161669c4de0a663866c247e4888d8678815fb2730463ec350b3e48e504158e4ba6b1c46fa31249c5eb5e1609d6947981787002e9c89049691805d2906bb0e25abaf40840e003719082bfde738c203c711ab3e82dfdf08140f040dce2d1aff9607e1cf8e6e9a654eeb6a9e81cdbf9ca94595aee5606c562b797a91e96fbfdf6d4dc8256a657142fd8a7f5f0920f1280372dc579be2ef4e71847a252e24321673cc0151cf1ca31e4bcd35611c92d524179ce21867060e2548c11bf50f0862f7132d148434c8b2504cd910964d2a407c93904c000a8348403b488a61dfbc08f03e511024b236740bc5bea5e94c219bed41d03bede26986109a4fc5c8b4b3ec5e24ec7e365bf395f3573fd6ca7392beefbde55a6bbf24aaffdfdb23a1f9c84c63a9520c967a596c979bb75c3fb7967f836e012fb937ca7f6ac8ec382593f957d65b9a93eae80b851863ebddb4df81d30d56560a6291f8662431973068c609a7ba53470441ca282b3689c31364018e2a25721a6815882a03f193efe1aca501b38c84c1f149851a7146801f0f2a9d18e44f83f35567085b94a336ce0925e1beda30015c09da4915d0e26c59ce91f1bbe4523f66b71f3244ca3bc2b503d69b7787f78983ffaccb1b9e84dc369aa4c51faf16c9a2b2405f9ada47631e19fc3e51f7fed3bae6e5982d38249bf3bd1ed52eeb8292ef542c8c526e4f53e2efa87463808224e9a857f85904433c6f5ed8fc6af7ffdd9c0e79fcf5da1149eda816245cba3757ed9e794673aa57a981fe3fcd8de747e7c8969a3562cd6aaeb7ab6c786b5b05e7497e238a84c6bf369b6515a97c5b94bfc644f288495427186b9010fe41183e73252f80e8e09d569eb529ab54885718a1a2530661a815061040bce313cc5679f50c4d3d0c59bba0ea7dba7ee70afc6b99d7e5a0c32c75263537e8cb8b7e5ad4dff50d78f936b6a93f879655b7cd9e16b8377c7e3aafd74583eecea6db11bd66615dc699f48d8ab9a0ed957effcb86d1dcec145e985ba8408a341551049e151706987a3d2a9593a1aea1008152350c40e3476fa5921e284b54cbdeb9896448a938e69acbc9754c213ec91b4c94dc568b14624e5aa04b55100bda96fdf833426c129b0fb3af2405f9a0fcfc3f532d113ebafee0923ecc703ca4479b40033f82c572dbecbb4bbb341ae59a7fce0fafd61a83c9f96be53798b5e51faa69fd65af172237fb52fec6435ce42262ecc36282fb5857049c834299813cc85341c4c9a80f80c7bc518c43d887b9a443130831cb5c8ebf80e32f69a6d480d14a97f2215c991a569f246f060182d983e6153fb35a0c54914960153401e92409a0f118c9dd5e87c320bbd4cc17b57fdfe0ac82ed8f9b126054bf4a47f6c4fc739465663daeee67d27cedb8d7bb3793ab1611a0b80ec8aba22f9b4de43c23f03b2efe7e4a9bc709324383fe4510a9a7488388df80028201092cc688c034ea5464194870732ed395354712e90e7ef217bdd2419ad5610fea7b9c34843ac1f4324f05d384da8b2c428e582a62115dc68ca11042c15dc8c0cc881270e587c0459b264e2ab21fbbde8fb9d3d92ab2e2f2e9f9dc6f7f9f9c231b1dfe55c90225f3e64c67973b22d9c5d3528807c5af80ef7f057e9fa6319ceb375e1c60f0851ac3218131e313c67c1788185233448ef09830750bb9420027366621a25408865a90cf89eadd78d1f9cc3e30d6452cdac486d60e01821f8d122229fb695a0e0a580f0c8738f344e93cba481309f53a458d4c8fcad6cfd381b7f28b2e266532c89d56376fdd42c64439d079729f47a83d5dae6e6c313fb85ae82eb9fb3fbf6efc4cb5beb801ecd6900ad2fbc8814c272013a4ca5e9d62933c9d2f637c6013c03020cbe390641b007c3e8d8b918fc654a6c9ab248feee019ef56387bab9600f78d7ae3c37774fbd716f3fedee3abdccb067a82a9cc864cd3078c72baa89df4f11fd44133c25979736b76ae340590513b48f14c3476f2901b54d150e1e2be7bc4392f1905a1b14120059e010eebd6deb92a09c4eaad5a0e9907120d9188a0ef41d816beb002e91be8c57d460ae503420cd806a4aa4761c7e9b0460da427e1eaf64bac87b8d7fd924f5feb846bab5c72dc199f6ae3aac3d87c3531fa2d83eab48bdcb9d8aa56bf28ef8c3c4e3713c5f54ab8d878a9886dd73b15edd747b3e7ad7b8e7cb52b736699fda088539fd7edfe18dd7bb9d2c8dcf263756ed5a238a15d344b5bbcf0d597d92c77c79bc689987d62c33aeccdf4cf191e4f5befe44a7b874f4278d40b902192f1ce5a0aa80270bee2ffa88c050210e21a94c5350a2c3366de7e55e45081fdc1b3ad3ceef573ad3fe9228426a344c7b369dd65e6267bcc294408c6b1d41f0f8581984302c18120232840ace0d8426389ea753dc51f2deb75e62f88aa56c344e3c6476bd87ec64533de84183ca65ab72dfd93e904d7f733a47f11a3af50770ce488f3eb65ac3e556c6479a6d96f6c5958cf9cca0bfc9df8f9ab9a79311da5afeb66b097d560252937360ddf896de25ef1a8cd7069d2da6b54ed6db0753cdbadeea7e559fe5abfdd276543fcd202afd3dcf2c2e0d2a107154080a547295f605c8601c0601e62371166c9c03cdcfa8c136a4c843882819fc44f43b384f820a2b44e03c40180257603ad5c185c3319db1032e98c900ce99100106d42a05a6d21a886983e3d8601310fb004e964c27d25f0aa7fe0c38a7fb758390cec3f2febeb215d32ce543c93a3eaaecf1f1b9919793da9b3dc1e8379e3e0b4e7d1ecedd60909dec2aed5ab6521de986c782d6d6c54561b12f75f7d5eef13424e1100b913374de7c5f67e094976e4757164907de16ab208c8be06e3db79e015f69c792b74a0354e0eab104570dd0016d54917770d2d7dc1d4122d94c8ec044c6941c465259afbcd13c80a3472a32cae0d71a5bf0415813d08ed685c040b0a6c2e61938f10b9c0c74d56d435b76aac80e957a66d55defd8c20f077854eb1f0647d2c9ed74b69dbf22e2cd156a8b43b30d82b1d9bc5fe96650a490e94c4799fb1d5d4776c8bd918da09daf385a80e02f0e7a6f5a893378a564db85750740496bc5242846ca802f4930451091a69203d5f0b92b2bd3fcd934494304f821419bf8b7593b08645eeb0e1c6c1873a05fa802911818b14e6a2b1df2246d6fe7e0c4d336d1a0c0dc09c120d4913675034610054219f5f978e5cc8e74baed67cfdac5c2b054a92d45b7eee87e277518ec746e7c395ef5fdbab4f0db79ab95cb4d432bcf27b555b3","52ac6cbbaab61f0db17f7a8317a7f48a2e5af2fdbd00b7ddc55f26f427c32b0dd8e3de3bedb4745a71ab90d552801c240643b4a2b111801f4afd3838cd62248228056ed83ba295f0e7f14a73176f0d7a3f739846c6aeb3834ea9999fe79f26cd3deff3d1e37dec0ec6cffdcdbc84076fac17a1a9e077395ee81f324e03f0d2979e28c09453385a11824a837485a4e0a94ce026289aca069a589bdc178fd15870ea8c638cf57bbc5e6b0eda44c3e04a1628438c094f303310018392034023c8429cce4a5426fa741006bc5a1900982b6939fc1d6ff162bf62f22bc59d348b9bdf31f9138cd3b81fb89a5b76fdb4b7ee86ec30bbd6765816916570f99156f6d9377c2949af38b502eb7fcc380d05bae6420346753a1fd350839095a9275b736725815053091c30f58e3963533f04b1d4450b7e2d95e9df1206a1efab0183b040033b101018d0fe6001839660b4c0f0a5691c3e2823b40e42114953bf370833161cc4cc82c908effc2c6148dd617e47c5df3e6c2ab3c9b28735ed8e3b6cf3d038749afb7bc5bb9998d734379fe417d553c0280076c5b029acfe21c3a614e797869e2c201992aab6d8b1c07504cde083730883ebc21ae3889d8f51788fa3f412228aa80879a7ee91780d3d9176023b14381064305320e42d849bc8590bab2d20d8349253083c0965a945cbc35789710451882da83c6fc0523b2ab9e3b7c9af2be6dee31fe155eab5f070a35af4990e876a3c7ad6fdd6f2a95a293cd4baedd2e2c19fe2c5356257944cf1678e3cf8ab2700e0efe2252e945f266df145346270903a26290e9c71610977700d998ec6212f0d1a010b0f3e14132c22e5e21d5eec557e590e91679a7cec034b960f4c9f43229d15156504a74918c0048e9380ca27326a94baadc1a639254d2402fddc7815bbe376c8e78ecb912cec47d3fccce1fb8d528356716276ebfcfe8df5e20ab12bda3ef0776731de78177f99d09f0daf347f311866c064f9d4cb2c0193d4a9161902c34802479aa354c14088fac8aca5528874f88eb75845f1b7e2457ed84fbfaf0e4db14f8bfb200f95a77d71ddd6c76975361fc4f2413eb8e91bbc6061aee8a7c7e293f0229f8017f949f18a844864a463de44047a0aa5fa6b48495d42229731f54832968634a2341419111d387865825e607c376aea53f0ba461613faa3499fa1623af365c3561b83c268162a8f83be6ad9deaed86d6f9e26c3d3f37118a349db5eced7e7cd5c87fb38eb1e6f5a8b9f8c30017128358c21928eb7d1695e9a0a809a151ec43e55388d68273a4ddba04832d0fd947a6105716924a4fe40ddd3bbb407137fb501fb614dfef0b018cac26af3bcc83e47f5586d3c8b40da93e1d1e46a72b37ed93ffa076002717645f60b934f32605f9e9ee0971696124aa07cc06309c629486eb02b2225f4a9c35e1b6244da33e194e3e9f8436f88c242f0b7078f24bc5ed53d160ed47a7416c2001e28235a3a8fbc642c62ec2d4391d0b4b7d7c0573111423941005e6379601148fc19f0fab8e323ac6a94b9ddacbecc8ca6b3792c367763df6a2fa7ddc2fdb65a68bca52b9db572395d9f38a8f8af6a7bfe3dd3f5f7b1c5640820d9235830cfb9313230881a31a31a072ed280ec40c0aa19f8594809560ddca4938228e1d39174e223b69273fcf249b23fdecc280ee3ee43b92757fce8eae375d94feaf3fda2552f740a7acd1f147b43573a81ec0aba3e6b92eca70cf121df4f7dc90b535f019c96881122394408258e09ca35953ee268a804f4988bc411636974a94d368a988e2e09ef097b4d7d29e5d3e1ae8462171d844f3415e04c0841631a94a75859835313519a7d41d2811d3435740415b8e5927d60bd70228cb1bf3fb9ba1aa8667d56dc98a32cbb6db6d6da9bea8897f399ee6653daedc7e553c214107645f21ea37f5072f5d2dab6c6119b609488e0a29036c2c4a8108475cee3402012b48131190d774e47ce49f40e6c0f57ef083ba96dcbe041a12991861150a522d20cdea961a9444e53c5c83301ea8c82d24b3ddfcaf0d4859bb6ab7025c439c2d2a8759db625b29fe0c81b5a6d579ba3e769b95df65a0fe573e8aded7e7ca8e9ccd363280deba7846920ec8af4fd3f6758b1a6e4c2fa10916940bf303a35365066d2880bad0345213598612d6cb469fe758c86002329010a564dbc35619ca893898ca0a73044075c80844f279cab289105e47d043729e09b250902484bc70bd2984e0423de41dc803d91869c7192587590bea3f0efdf3f0cbbbeeac59cdb3f94766d9321d362369bcb3dd9cc3ed399e7d6ebddfdb33d3d61359d4875cd89d3ff1cc0d4a5e5a1c893f6014bee83559229e4406969037a9b03585ca9e07d30c4a72c3e76da8152a75ac7b72356983c290f51f07941316f7d9a8ce76cd0a97942626ca2964479663c584babc15c124d39b018d2ccfb6841e805e3ce049008a763e128bff1eccafa4137379356aec8cce3f17e6127e3e3ca2e4da779e4dd852c8e1dbbc682e517d545b15899f7e69daccef345d3144af372aff2ac5cfd38f5fbd33d033c6557af48e0b32f07eca6a5f833608ac84b671613ac08b7f09ff1016be3b1625130b02612c4398750cf408887937734220d7de2d60286ee6dfd11eb9399c5e05803756954712a43a689ea0a61612d087ca4a5e7483a0302d804810401ff6b706a0b4b27a5c6989a363f1fb0dd735dee773396eb3bd933ca041f9f32b3897d10ae539f75c2f355156efad0a80efd43c6fbc2006b5558b49a87963f2e0e73e787a561f53d60d70c2dfe7a0b76cb52fc6480a599270a591194320edc6adac622a90842716f848f06290acac4a7b36d64700e4b16a95534461bd24cb84f07ac41e78b7ce3589db1657653ecb6da2a5b3d3e962937a5c3612aa6f53f1f83f671ffd74017787d556eac6c461eebad71e3697f7ca6c3c9e4a1511af697b9b778a58117979f47f279789d3f79f7fa65f8d9d0629ca57ab807ebe5918a013c6a48c743005f2e9d2a2e180d69d313083b8815bc44d105cc53aacc7b1ac3cf60bb3e466b1b47f9f16142e7abc3e17e4233fb5dc73e2ccbc7e7dd931a55ab4f6fd1e2ec8aecbdfc5ab46e59869f0c2d906fd610239505bda5d256b9347551a7a3277810369d75433c752996d420b99004cbe6d2e97096622046bf470b2761ff9f495ef4cb379bfff824cbd9f338968fca14c6a2380935bb1e4e87eab8b4ca4f0ae3d578710a57d25c57e456e9174ff2ba7129ce00c6b956d7ccf2b79861919a1c52e38c85880f3e7e613072c1f174448824c4a5036aa28d840413d51bc09046989f9c950adf19820b5222923af4e10a2ab5f7b0548b04662016353a1d3faf74ba1c5628fcb65f8f7a1e903b0b1841e9ac087ad334835b8627fee5e98985f9b8d2298fc7d9e56ee1efd7c3792fbbef3f65a68be1e08827b9eee91ea1ff1c58f25953933e4a7cddf2966ee7f3d71f017a616a43580ef808a6c0d5191bb0c0d20355144b910601a5f3ca45ca3a282e58eacf61cc839b14fe3da0afa98dd4c9aad3f9be96521424f7520730818a51af22440a589294f348930ed3142f01d1a9a0122204920a03549d01f4658c3f1377ecc6edc4f7597e2c954b4f9d31cf76ebb15819e45467599df633b5e5a0b87b3c6d79fffdc7c7c5cbdc72bd5a2eba9362958efdb8fd7088c6bb4275756856328fad82383581a970794debfee76d0c811ff4f7fbf8eb8b7186317131631017f2b4f9cde1b497d838eb850457879c713c10e682579e111dbce02c28ecd39ea2f707462375ca581a8748bc2712b8e41080060ed63010c05449c3a8014c890a8a78cc006a27bd86f0d36b5075864bedce194192e6131376c7d5dfee651b78b7a8acb665af47725d18c9ce31d758deb3e7dc7890150f95f9a2736a4ac475a7c9e17f8c9715e2d2b348409e594455c488e8483d15424503f1606a80b5d26a06462da6237cad4e473a040e141861df140090d427679120000cd4a0b65ac9a4111d881904368b094ad3d971a95c0a4849c6581a18e0925f4f33b2834e8361a93d0f184d32eeb612d3e71600f23d966de6437edfe6d5fba7d5d3b6db286e6bcf8565be1d06ad11ef9e02a6ae3bf20bfd53f2b309b00b2d1807e5c653129521a228939413953c24483011a5f760b0bc61e0d1bc88c9ae4597fc9b75ef017bb5602fc7f412a16c0a07949094c63467834beb34a5294aa011bc2fe55a588dc08639e0d0f074b809c4a2ca7c64c1528589feb7c9b84f98cada9974778dfb6c7f3cdb7433b53e2e540ae35299adc36cbbea4e4a2747cf49d0214a0af11562eecc78d6cbdfd8efb31bf1c7a0910bdb3142c49c59cc513a7e8b3066433ae301a244914e7d83e81122078fc006018f1a83a40fa93b27e2f7a0bdc452abb559fef639ffe7ae523fdb7abe36ff4abffcf7ff03f31f5c4ccfa50000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&skip=68')
      .reply(200, ["1f8b0800000000000003aa562a294acc2b4e4c2ec9cccf2b56b28a8ed5512a2e492c2a51b232b3d0514ace2fcd2b51b232d0512ac92f49cc0109d602000000ffff03008e5af8ff33000000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      return callRPC('listsinceblock')
      .then(function(result) {
        result.transactions.length.should.eql(70);
        result.transactions.should.eql(results.sinceBlock1.transactions);
        result.lastblock.should.eql('00000000b983bde4a220ed5ff88d8bca741278b8e3c6ea1b547f79c0feb7aa19');
      });
    });

    it('listsinceblock from a block hash', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/block/latest')
      .reply(200, ["1f8b08000000000000034cce4b4e03310c00d0bb783d458ee3389f732021815838764c47482d6a073688bbb361c13bc1fb86dd6100fe99bde5e98b9508979788d6bc4dd3ca896a9b6d6593a56916ae51bb61ac595553870dce6b7f3b1f307267496503d763c100c2544e584e581f8946ee23e7875ae81936b0b3ee97a7ebed1d0654aab93611616929313729021b7cdcd6d77efdbcff2b6a4fcbb36ba04a602bdd0a4a5b16ae54509bd14c4b95ad636209f2299e6b306c70dcf472573bf6ebe50ee305a6387120d71673baf7aee639284d2b6a8c829ac5972956d64a4149b96429c118aac60caf3fbf000000ffff","0300107abe0240010000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/block/00000000e01d2696b1b6fe51883e0fd0ece2cc45f7eafe86e3d839571c78b7cb')
      .reply(200, ["1f8b08000000000002034d97c98e65471186dfa5d636ca1872f27320218158444eb8856423dbb041bc3b5f5cbca01755b7afeae489e19ff2df5fdfced70f5fe5f77fb7c8d136db92d5dead3286ddf24eb9fbeade5e5fbff1ee68d7ceb059bbec3e56dfebebbbaf1fefb7bffdf8dbd70f26a3f4f1ddd789df2e276b91fa7df1efc5ff28ed072f3f58ff43d3f9679ed83fc6b79ffef4f32f7fe7cfaca8ab0c556b5eb4f6367ae74ffef1cbfdd7b79ffff9ebff95d8de3b1420d36bbde7ed27dea6ac706da28f020bafe7eb566ea5c8d224f61e6772da6fbfc44fbfc6feeddbcf3f71e25fbede3ad1de0e69b39bdd29d174fbec1edde8ebc4ee4b0b6f3b7395ea3b66b44e3f941021fd702415d411b3e5647cbf671252cee1a38ef3dea8badf28abd11f63b1217354d3eabdb779ae0547c8ad3a87a98fa95ac62e9dd3968c2db7dd59fdf6b9e3d5d9b7ede26bded2ea9c5bef0e3576c31163ab5baf746db187de17c2bacaeed38e6cab6d8d1e8de58ed1753669729fdcb3eb1ad9c8e088292fe841c44699d413e6dbfb79fd9c11be57f472f42e953ba36b6d0c63c6721dfebce94a045caaea6f0c1d7314b328c654975c3d63ed79746ab13bb414977d25e6e86b51e7686331b56a398b525bddaddd767aafeb95dddeb9eeefde72d6e0b1916fb51343e35cb1c2cf4a0d47a6d5dab28a0d7eb731f7356cf5754ce37a1c7e0f5fd7fa6ab3d615f5b4716ae360332fbbdcbb0a48b809cc37eb870bb74b0772a6a7db5b6b3384f7aadb1c60e34c0830348b1baeb040ad4edb6b3d8e5876a145a9733507346ac7fc580551b75726f8bacf9005bfc0c66b7aaf351dbdac7202f42847b4ce166a9cbddbb9afef26f5b6fea0dceb563f0fd966928316de0214da7579616af4b65602bec83c035abd12c64ec1e7399c32daae55e575eda0292b9f3c1720f45252dfe7316c2deb83ceae6c1b4dd8fdcc16b6d6ddbe86ec751be2e051cba483a7adccfb2a1b13bff7ee053597586ec4f7a1b098cbfcb1b5c71afcac765a31b1d7279b93ba47ec2975c2c0f57aed41e90cc4f696442767696b3112d0ed2d50633d54cebdcadc063d43d158fdf93c8b9733f0c7664697facecaa5ea6973be77e3ae65ad4b836fbc5febf2b1bb8eeaebf9e07d006a2e5e52f7547a84949228e688ca0665dd5aaab47d9924d558b3c57bd8f698eff8b3b75b5df3f9856890c4d65b0e796179023c3b2d73f63b7658f4f5b6ca1639b1ce14f8c669afd4d2bc9540c6c2bad3da03f82880dcace28c7eaaa00563d6d67a03c48c718df6e0356feb8e5a4f29b3c2ba316540d6c179add0e9b8a917de40b61b6f0e7a6337d17745aece34d4671b2af300f6394841f812e13407ca0d55e4532eb59d3d5344a226be58ac0eb453625c08bea21c1fd0b8b206fe37a8a9a7369c7ad7f45ddd139d0b90e93b8c0b96b0f6378b0808af1123450a291490322b2d523e6c6b826e18129c5f72840d433d2e4680d8706c4d34b17364aac0e659ae5f203503e5bc8c128086ddc6b46de8f39d1b613b615805d86910036939ef96692350c9a2345a96417dd49b3568631e9e98ad968f8e0fc0cd9147a33db402d0015bc604de11471e535d10e86dbc4bfb9b49295b0a10a817d14ea363eaa1bd0a44caa9af09675365a4b51ae81d2feba9afb5160db6b2d012ef5852af145f93ecbb769765313d77613b31912a84276967ad2bc271b2318ef846cff00736c852f0aadd56cd592473728b69826bced2c1b3bd1c84417ec4d82e4455b41d4b7a0bbbd803dd44574f6b9600076271c904312fc2e1a348aca109c77bfb4128d8af17aa2c05b3f3c1eceac088106d2c6ca6f0c10716ffaeb8cf5259dbaa8513efe9885998acde317c31a8c7d8d1dba2ac5eb06fdeca3c38027fa6c0a0a8ebd3eee19cc1730dc1028b3df53caea93294352a5d6e296a7ea5074bb9894e9d5be0f3aa708612865f64665ec4a43db772fbe033bbb29b04226d20db842576f36933378241e86b30475981d7206fdc326ea06690e1d0122c6f1d0dc32ab61f65f738571bb815ee9e9e4aa94fde4e9ce87a30fe384286af4e21b530ca0e81234df692573047ec145ab2a64eaf2539d2d8cde055e2d83daea37e394861b24046da50de8f34639cce6190ff384a17ed2088fe713335a3bbd3a224e8e73e88688d99d988d8e40404e6b9986354c347d122ec66bb7a6f14f9512d64f9328bb22419f660437b68f8c08c3b31526fd9780013754853c83d97e390ec9a32a491e8a4524c17698424af4014a28b0f3d99912eec05a40b52c1ff148f37fd4d0426c66ec4a3b5f388d95149fc93b4439c706b29f634a34096ac0633facade95c000626be51b5414dbef1843495c1c7c1de462328df36b7dd9ac4db62a3dfd1d3b24216c521e490aa9c652e384e5a00bba9f6e1698610bf88463286f6513410cadb8ae2911c4723595e42ce8b96e7918c4c25efa719ca27d968a021c01cb9be0aa4823b4cd88a78609cb30234f4210dcb00097ca1f1ffa1c5e156dc57f739c6418765d2db0fb7900128273c7ab201ebd24a33a12d236b9e66abd9700b594cc8a5335c4367151e7999b3cf7d00ccc6a8d12857cd58e1338c8b47d433204e4e05e97c01b081962b631bf54fa143ec8cc47de8adf96a6981ec8db68039972ae95299979164646e2e7ca41b548f14ded1904993c82a4463424138ab15ae2211cbca57f2c2d73ec1d022ec9884dbb8080d1b0cf859d16a49aab466e04a59fe9d33708d70f92741e10325366212545b1a25c6c0f36e6ac9a24439825a3d8c0a73377f679a4406c384fc042886359c19f8e33faa6180fb182057b5b8704fdb0f602d6789c559f243b4e8d8c94a5430cdca01bbd00363d85b03c1e091199a0e9b58142106b372986ebc83c075fb8ef634577710721d28617168f3966608c5d038fadf83319761205855b41e141393d95013ea578b4cf4672a0907da4b07f88f26efec0258265a2d4cc0d6bc7200002d87ae09ac5d5b2a838e5f79213f18801885fe20fcca2048a582c6480d05082133b136ae93fe85024c4b9dcc92b702d3742b47e385e7187089d00414c836669bec41c4039014ac712842b8902fa4a3431ee591d7696f90178050513ec06156ea08f9a2b0efcbcc873eca0810c32bafac41df80dec8501a1be87fd24b41a4844ec49e6087e63a6c61cecd6cc679ae15b3ca1f872b3804d9c237a69c9a7ae9155442a1f7f70bda1264207233d1443231ff20505a25ed5f6439fd914a190ba01312e0c0c93ec43b8073187f481869f1334989ab38ff1322b4bde8012b479e11c0fa509123217c0be2e607e9f8bd5049444538791c4e6b3c1047721f048641ec66df692a332dd6ae6c2bc99710c0a498724f7ff792a44877d4ed5981f2143987e6453e17c809500b193b4701ccfb71305f3d66b89afcf38d98e7033c7c71b77ec05a38430ece92c0c82a85790b20def893fc09dcc73b0844f1cb2f3bbf041cd92ee00d59017c210b774792441ae6bdc24f3e6392a913303dab5e29bd8446214def6b67dfdf53fff0569f4c26bf4100000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&skip=26&minHeight=318078')
      .reply(200, ["1f8b0800000000000003aa562a294acc2b4e4c2ec9cccf2b56b28a8ed5512a2e492c2a51b23232d3514ace2fcd2b51b232d0512ac92f49cc0109d602000000ffff0300df7007e233000000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&minHeight=318078')
      .reply(200, ["1f8b0800000000000203ed9b5b5362c9b685ff8bcfd52772e63d79e3261c0542ae0227ce435e416940b9cb8efeef7b2e6b778bd5580db4754eed886d5444292c5332d7c71863ce4cfe71b55ad8d9d2fad5c37cb6bccafdcf3fae1ec255ee2ad0a49c139293149317d68944954d8c6b2a3d738a2bc998673a48cd0801cf157540258b100c24a5afbe5c05bb8a381225207e21f417223b147244e504f92f42c810af48112f00fc817cb99aaf574febd5d757b0c11fae72f8a0f57ebe9eadb2511a06fafbeeaeb6684f52a96e5b7edb1c4753b2ebf1b03eeece7795050eb8b1bfae7f1ff2ebd76f5f7e1f0ede0d57dfa50117f0341c8cf5e4b65cafb8d44b6c9b7fa69cc5adaff79a6fc3492985d64628a1bf5c3d2ceb0f337c70b558c72f577e6c1f66af63bf7ef7dfb310775739237efbdf2f5771b65a3cc4af337a37919e2df276a9d568ccca2fb2a2f7b56b3d9a55479381acf5ccddb2fff6977ff93a13f87d269fb01ef8c2fc7c961e1653fbaf5bae2837b8d64f71161e66a3ab5cb2bf2e716aeed7b99f8ced728c7fedf7dfb6da784d7514a023231c8c4e5a3b935cb28411498cf0d6336e7dd4c267570924865b812f651c1f46637ce58c52503a9bcc2b670895639c449622a18e06e2a50b208d0462b4089eaac835782603371152000b344816704d1c7e0b9fcf597e7a7b3ba5fdc9feba515e38a86fd352e437aba518172bbed5dd3d9cc55923df68c2a6fc7457a530f5add86f966a77bdebbd1c5ab19e3dca72ef6d38f1ca993e8333f57fc0d985ebf19371c68cd2de0a02121215da1b008322a682a644588632a6b80b2924cd8d02c151d14c00edac14d4281b8e7346725ce5b8b984b3fabab0bf1e0e262f2fb630dfefc7d48a749b7fda36f7dbda4b677cbb91c7d6f543cca4f4f139c6e6b4df0a4339d3853be6ebfdc2b8d170cdfcbd682cdf46d3b830467c7d952751463f95b263905db818c71983d3180b0c05c5780ed608e482782ec12763ad8d42f820984d347949830603567385d73010f45bc6d49b9619c21c47a2705c03c61ac2051146184922a7dcb1103c6a19152080e9a880b114a89634051685639fcfd86a987fbeb9af158ad3d5e3a0a9eed3caf707a8a2f5c7f2466fcaade1598ce5e7d39eacf1fd436d97fa8ffdf6a4e267b36967f6bcaadf0e2a0fe3746099867362e41952063f1eb2cb56e327830c9715474a311b9200d2c01daa940b5669c8c64a8226473c0e633c8aa8b05a29bc134af988718dc94f87ac51e66ed87e587577f356ed7ac4bbf2b93a795c14fbf78dfca65928cdc55990999bbb7cbe365baedbcbca64b215ad79ba2ff69fafb7bdfb4af477e3dd01649abfaec6e990b1ef4176f13c3e81d49f0cb26493b42a7087362b50afbc900c92768e2b1713184ea4e49a7b468113215dd4689149114fa8050eee0864ac43780e640ef84590150bab1d5b8e9fe0ee852de67d1e3bfd3e84a18acecee1a9fa7818a3fe0a317dd79bc799974551696f45a7b4ad6835e8f46e9adba4a1cfd94172369957ca33bc927c8fb00b2771295fe27b74692e4fa32bbbf756326f9552d6f084b908e383b08a9ba49205a112084d0dc626c26862c90941c1c33bba4053fa075d60a891942725a3234eea88ea14004731c6680d58430a008e4f309d680c04c31f4e842761183e618e6531e810c8652ac62ea28b4dd47dbbfb344d2fd0196d1eab0feba62c2df366d7be1e770bb5dd5959acbedda8f45cd6edc180ee4b543e6ca6ec5ed09766bd56ae9949931df8a4229984a9d3254c9b1fee9317aec611c89804751a6498b4598c3226c904a67fa235d78c582e9124acf998e0d6712645e04942c0d20f1f898abf0ffc4004fc0199cea298f15ef2e8b8e15298602d4f91729e32f10b78312112c3bd61f87812c9390556381f01f02f7f0b19fcc24887d21c831cbb10b2f61cdcd2a4752de6597db12c54eea6133ba8f72bf7cd1954ef2b6fcb9acde5fb1a561e4d1ab5a1efa2c9af97a5ebce50783e48a9789f57a316abd40fda170a32c6ce282b35ff2cc6b2791c47ec92b538421807796a498919c9196054086d494c3cf8149440e05420c814d690d2b99428c567d153a5f00e5921ef082382bc95948a730a91202f949ae44da28147afb0b46438b04581d3ca50ad928f447b95308469746524382173cafedc84d5d78be48a86df77f393e17ebd91153a698d58b1fb7c536da80d5ff50f5d522aa34e77492dfe03d8098031708a13ccf520411a5432cb08c721d007bd8b5293ac7906d46a4715f718f3846752f96059d2dae8f411608080d18b00e3b5fdcba623f9ca54fb55dbe8d77af5f5a8c1f72ff93437cde68b3de20c1f4a189fece4e398ee3babb6d4b0b7b779b3a2777303137aadf94bcabf0d46ff3c187d3f987832ae5fe44ff39bb2138f0defd6b4b05b37627b469f5d79f5343fa0356be6ea3368fdb4fe07fbc8712f5d8abf7d6f8e137f62dd415d562524aead47544954d2182f106aab7c42f705a28d523121ec8ea1c332af88563c7d4bfc5bdd91bd51b082c09b6382b391808a348a60f02d234079e79910828b2c2046aaa91722a2d2264731516209248e130f3981c4c38f965480bf32ed3c4691bbcaed6da17c1dba2bba8c9df17c3ef52d3e6889f6935bdf1e9ab69260ced873d0e4d38221fc7d4d7d5b8be384d1d30813c433ceac954441d61256044b85e429baae8a21242d53861c4b82cba83d5eed51785fbbb5ef08937f102685754c63a6141135c0e2509c319588769a63e5c2920f0a222411c039ac4210371c31cba6783f94953f3761f54d9c99475f9877ab167acdd6d0dcbce8594aede7addede0e9bf5f2810c6a944173ba0c2af31fc04e002c064e65602a0a69c0702d5cf45c7889052c135904044f8c4d241a0c0658ef266f7d54e8e9928117361e058ce89c60397159eb84f607f3e66dbf59e9f66fba1595df3ce6a196afdcef93142d5fa8568e6ee07c0005790f05551f77590a37f3feec69650a2ffb9ddb0d0722de2d9e96b071ed69ad22ebe650ecb4426f3c5decd4e76e491c65889dba590509ef2265ca4b97853009d66322e34e80c444a62563d1a1154accc889220b4e524dd0ccde33440f36ab0cc6391db9e59c87e824c9766c9c46aa9c8e10d15b851729309b70142b64100c4224f89fe0c6a394fd99216a3a94bd327451f0ab6f2bf79dca7026cad5d272381f540ad4958aa1e8f8b6d65b9686ba7c4ef02b0ef6b7d77bbe6e6e6abdfcad30bb627d66179d52d796edfe9ab5f9c15ed52b19703a19f253b7448f6e235cb416c708437339b1c11b503b700d84f4163d0bc58aa34c51176348ce99443297529a450422ea609d1259ed40bf210cd89b0d5ac5104665b32d502703cdf644136a16e5100d4789d2415a82c373e2b3da0693570c808a6835b7341e278ce458f6efff9fb0b2791c5d8bcebc29b77950bd8e7ee93ddd3c6fc26c5defdd6e5e6edd21610609a3671026ff8d0853276a5834cedb28057a5d324118871526d8a059b2c62a6a8444b1b18a88e41db3c078e2688ce69be215ccc1c10e4664f0991146e6bde054a16a31117466b22978fce514d1003dc14b18c5b0252c533a319982c34b8f10c63a807809cc5a17f960e909549d979e7ceaaad1b6f5a877e3a7e7ca5db3aa76bdde52e48b673579f7fdc5f5242df4ec6ebc59dda00e3f8b7d1aed46bdc5605b9a3d944a871bee0211e36720c67f7c93f7b2d5380219bace894d5ecf0222e0d113b17273283c142b39474882a8530c2e882c7071a282a2d44615a20782be76081918066f4d5e9f69a3b2ce62d6d24c4a23b2ad08445930661d3e1c29498c53544e163d86302b28028c210cab00c6e5e74306722ab7755a7c98d45ba1e03bb57e1a8d6e68c772b719f875e5facf5b3c1fcb989ad71f9f641142a5c6afab4fa2b2a483c87793da0af2dd6a73b73f648c2063ec0cc63ead07273e42eca2b5f8d9088b4cd06c4494252f55d6c5e00c32d27864ca59a5bda768b5d640e45110ac14699489698c8f0625ed286184e598cc09f1a38df22f7742c5666fb6fb6d6731daa56e5fd7248cb63b3b9e551bdb9e693e960f4f0d3140493f631741b24f04ecefdaa4f82e5efa44bc92a35805626917854e96e26b318162aec78cae65e4099fcf5ab6c9078de8612eb79c3890e93d5e54bfe16562a2040b468ec1cde1b5d1eb94455e542f2e0380678c382c0310379310388b062d4c044534da2b3996c368266084e7d865d522beeaf660b3865d33b69bb3a721ef357a43d9f1ad817f9eccbd9d9f819794f5c77c5aa5fbbd9bb7b785c5f8a6fa72b75f3c6dc6fdc2cad7d2c1811b9ce2393b08f2bb05e08573f811fbec8267ef9753e032497182f868071a137c325c78bceddc4686c90c3088794583a01468667b0419908446f30d5c40def60f7830583480c3fa4126cc75c4706435219b8e0767a21752a0925116b9f64a65b523b1116b0742943347b40b64b67f20488e921f7d8ae32f437e7ded87cde2a2cddb6259da4d1f9be1aeef57d5f25d5cc9f03092cbd63bf142773ca39b2ae193ce71c0671d14fa903049d88927399890d107ef68088c7a66744a8065a5d154021598ea6324519a10826501944a3401e8a4de11a6257b3bc9211944b43ee97c020341397444ea","a940d9c320af98c512d26a9a10126b58c633e6af8891dfe9e02c83e384418ee81c153f4119394b4ddba8349b6e30d55d368d2bd6ae5e27b8d9377d61d4a00701866767574ed72f61fe6d8a4849f8890a0618803466a54089903209998c53413aee84c14acf8157315ba6a06df08ca0a2314a51f3bee18b1e2818860e41ad006248d6e840418b31eba306ee31bd31a13920519c667d10e44c586750dabc88c4e964d851be08e4805ed6089b2e36cd16e5f358aec2feb9d18fe556b9235bb590d677ed8e1ac4db73dcb1b4f7fbfa75afdb2c38da44a7e8d54c273f9a6c6eb86a8d07adf5a17e5185aa7cba7e09fd63c3d7450b710c2ee02776285ebfb8934e673becd41b99b4d73aca60c11a639104c032db2992f558858d243b7061bf814bd0b70e855786242e9563d26874495436122970ac0d1da7de738f2eeb505e0dc65ea251d3d02891ef10a3e6de1ed96c0491891727392e2f806b06dd55135ee2c356a8a1db8d6e36b3d9ad9a77681cad5be2b13b6b9cd564f5d3d21d9f9bbd99b566e33b356c869abf73cd62afb92989c2e2207b65e7eeced80812fc076bd7650b7194ae53c3d757ba5048acb35c04d417896522759e807e3d7891695522d9c692a398940cf88879ec1b6b1407e18b5b2c112c5a1e4918b9188b59470d9d8f27cbb952dcd3e4580ac0206447ceb2b3b6108d0c5a587c9ffff903274817cbc2176797d135ddcfc62f21dc74683e55aa7c920ff9e57da14faf1f56b492b70f93f5596737182d56564ff73cbee4d5446d2ba3c578d1df895bbddbb759a1583dd42e46199cd1c217ec07f375d9521ce30b2bb333f802ad911eaf740402ecf5534c217986210af50a7931912a04cb39458da298a4f8fbc68446b7fc832f97b5fbc15b2d0d101993d28160964766ad45f57280bfce1cb7afa7b605aa99f69105cdb5048450c271beb0726439d0eff862a77e40f3f43ba3cedb65fcce898a6263f3c8596fd3b897f5fda8d32e71d19c4e1e56b77761e5ae07078d7e4eb265fdfd567e42b4ff05dfc6ec6f877bf5518170f1d4fe4ce9a9bb0086b3e04426401e093586530159db14ad109c4c5699146c006a830b0ecb45ed0164a0f63da587bb0098f7bc4ac87d76e28a314b9862cc61d110b4cb9a278612f4548ada8b828a3eae957358df6a8955b005c18e528a018ee90bdb67e7dc604eff5a07e36ebc1f15fd6c506cecf6506c4ff35b256b1b59ad4ee77ad3bd3fd4414eb3387bba0ed24f0295d3cf28425f47f9b80a15a76e974702814aac1933a4b2cf6ea290911448f4310b5d22a96853d432532b86253b560dda7db35d0e9aa8d784bb5cd9c5d77bfcaf4951ac8557f395fd35fbf6b77f02b27588ddde3e0000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      return callRPC('listsinceblock', '00000000e01d2696b1b6fe51883e0fd0ece2cc45f7eafe86e3d839571c78b7cb')
      .then(function(result) {
        result.transactions.length.should.eql(27);
        result.transactions.forEach(function(transaction) {
          if (!transaction.pending) {
            transaction.height.should.be.above(318078 - 1);
          }
        });
        result.transactions.should.eql(results.sinceBlock2.transactions);
        result.lastblock.should.eql('00000000b983bde4a220ed5ff88d8bca741278b8e3c6ea1b547f79c0feb7aa19');
      });
    });

    it('listsinceblock from a block hash with 1 as targetConfirm', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/block/latest')
      .reply(200, ["1f8b08000000000000034cce4b4e03310c00d0bb783d458ee3389f732021815838764c47482d6a073688bbb361c13bc1fb86dd6100fe99bde5e98b9508979788d6bc4dd3ca896a9b6d6593a56916ae51bb61ac595553870dce6b7f3b1f307267496503d763c100c2544e584e581f8946ee23e7875ae81936b0b3ee97a7ebed1d0654aab93611616929313729021b7cdcd6d77efdbcff2b6a4fcbb36ba04a602bdd0a4a5b16ae54509bd14c4b95ad636209f2299e6b306c70dcf472573bf6ebe50ee305a6387120d71673baf7aee639284d2b6a8c829ac5972956d64a4149b96429c118aac60caf3fbf000000ffff","0300107abe0240010000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/block/00000000e01d2696b1b6fe51883e0fd0ece2cc45f7eafe86e3d839571c78b7cb')
      .reply(200, ["1f8b08000000000002034d97c98e65471186dfa5d636ca1872f27320218158444eb8856423dbb041bc3b5f5cbca01755b7afeae489e19ff2df5fdfced70f5fe5f77fb7c8d136db92d5dead3286ddf24eb9fbeade5e5fbff1ee68d7ceb059bbec3e56dfebebbbaf1fefb7bffdf8dbd70f26a3f4f1ddd789df2e276b91fa7df1efc5ff28ed072f3f58ff43d3f9679ed83fc6b79ffef4f32f7fe7cfaca8ab0c556b5eb4f6367ae74ffef1cbfdd7b79ffff9ebff95d8de3b1420d36bbde7ed27dea6ac706da28f020bafe7eb566ea5c8d224f61e6772da6fbfc44fbfc6feeddbcf3f71e25fbede3ad1de0e69b39bdd29d174fbec1edde8ebc4ee4b0b6f3b7395ea3b66b44e3f941021fd702415d411b3e5647cbf671252cee1a38ef3dea8badf28abd11f63b1217354d3eabdb779ae0547c8ad3a87a98fa95ac62e9dd3968c2db7dd59fdf6b9e3d5d9b7ede26bded2ea9c5bef0e3576c31163ab5baf746db187de17c2bacaeed38e6cab6d8d1e8de58ed1753669729fdcb3eb1ad9c8e088292fe841c44699d413e6dbfb79fd9c11be57f472f42e953ba36b6d0c63c6721dfebce94a045caaea6f0c1d7314b328c654975c3d63ed79746ab13bb414977d25e6e86b51e7686331b56a398b525bddaddd767aafeb95dddeb9eeefde72d6e0b1916fb51343e35cb1c2cf4a0d47a6d5dab28a0d7eb731f7356cf5754ce37a1c7e0f5fd7fa6ab3d615f5b4716ae360332fbbdcbb0a48b809cc37eb870bb74b0772a6a7db5b6b3384f7aadb1c60e34c0830348b1baeb040ad4edb6b3d8e5876a145a9733507346ac7fc580551b75726f8bacf9005bfc0c66b7aaf351dbdac7202f42847b4ce166a9cbddbb9afef26f5b6fea0dceb563f0fd966928316de0214da7579616af4b65602bec83c035abd12c64ec1e7399c32daae55e575eda0292b9f3c1720f45252dfe7316c2deb83ceae6c1b4dd8fdcc16b6d6ddbe86ec751be2e051cba483a7adccfb2a1b13bff7ee053597586ec4f7a1b098cbfcb1b5c71afcac765a31b1d7279b93ba47ec2975c2c0f57aed41e90cc4f696442767696b3112d0ed2d50633d54cebdcadc063d43d158fdf93c8b9733f0c7664697facecaa5ea6973be77e3ae65ad4b836fbc5febf2b1bb8eeaebf9e07d006a2e5e52f7547a84949228e688ca0665dd5aaab47d9924d558b3c57bd8f698eff8b3b75b5df3f9856890c4d65b0e796179023c3b2d73f63b7658f4f5b6ca1639b1ce14f8c669afd4d2bc9540c6c2bad3da03f82880dcace28c7eaaa00563d6d67a03c48c718df6e0356feb8e5a4f29b3c2ba316540d6c179add0e9b8a917de40b61b6f0e7a6337d17745aece34d4671b2af300f6394841f812e13407ca0d55e4532eb59d3d5344a226be58ac0eb453625c08bea21c1fd0b8b206fe37a8a9a7369c7ad7f45ddd139d0b90e93b8c0b96b0f6378b0808af1123450a291490322b2d523e6c6b826e18129c5f72840d433d2e4680d8706c4d34b17364aac0e659ae5f203503e5bc8c128086ddc6b46de8f39d1b613b615805d86910036939ef96692350c9a2345a96417dd49b3568631e9e98ad968f8e0fc0cd9147a33db402d0015bc604de11471e535d10e86dbc4bfb9b49295b0a10a817d14ea363eaa1bd0a44caa9af09675365a4b51ae81d2feba9afb5160db6b2d012ef5852af145f93ecbb769765313d77613b31912a84276967ad2bc271b2318ef846cff00736c852f0aadd56cd592473728b69826bced2c1b3bd1c84417ec4d82e4455b41d4b7a0bbbd803dd44574f6b9600076271c904312fc2e1a348aca109c77bfb4128d8af17aa2c05b3f3c1eceac088106d2c6ca6f0c10716ffaeb8cf5259dbaa8513efe9885998acde317c31a8c7d8d1dba2ac5eb06fdeca3c38027fa6c0a0a8ebd3eee19cc1730dc1028b3df53caea93294352a5d6e296a7ea5074bb9894e9d5be0f3aa708612865f64665ec4a43db772fbe033bbb29b04226d20db842576f36933378241e86b30475981d7206fdc326ea06690e1d0122c6f1d0dc32ab61f65f738571bb815ee9e9e4aa94fde4e9ce87a30fe384286af4e21b530ca0e81234df692573047ec145ab2a64eaf2539d2d8cde055e2d83daea37e394861b24046da50de8f34639cce6190ff384a17ed2088fe713335a3bbd3a224e8e73e88688d99d988d8e40404e6b9986354c347d122ec66bb7a6f14f9512d64f9328bb22419f660437b68f8c08c3b31526fd9780013754853c83d97e390ec9a32a491e8a4524c17698424af4014a28b0f3d99912eec05a40b52c1ff148f37fd4d0426c66ec4a3b5f388d95149fc93b4439c706b29f634a34096ac0633facade95c000626be51b5414dbef1843495c1c7c1de462328df36b7dd9ac4db62a3dfd1d3b24216c521e490aa9c652e384e5a00bba9f6e1698610bf88463286f6513410cadb8ae2911c4723595e42ce8b96e7918c4c25efa719ca27d968a021c01cb9be0aa4823b4cd88a78609cb30234f4210dcb00097ca1f1ffa1c5e156dc57f739c6418765d2db0fb7900128273c7ab201ebd24a33a12d236b9e66abd9700b594cc8a5335c4367151e7999b3cf7d00ccc6a8d12857cd58e1338c8b47d433204e4e05e97c01b081962b631bf54fa143ec8cc47de8adf96a6981ec8db68039972ae95299979164646e2e7ca41b548f14ded1904993c82a4463424138ab15ae2211cbca57f2c2d73ec1d022ec9884dbb8080d1b0cf859d16a49aab466e04a59fe9d33708d70f92741e10325366212545b1a25c6c0f36e6ac9a24439825a3d8c0a73377f679a4406c384fc042886359c19f8e33faa6180fb182057b5b8704fdb0f602d6789c559f243b4e8d8c94a5430cdca01bbd00363d85b03c1e091199a0e9b58142106b372986ebc83c075fb8ef634577710721d28617168f3966608c5d038fadf83319761205855b41e141393d95013ea578b4cf4672a0907da4b07f88f26efec0258265a2d4cc0d6bc7200002d87ae09ac5d5b2a838e5f79213f18801885fe20fcca2048a582c6480d05082133b136ae93fe85024c4b9dcc92b702d3742b47e385e7187089d00414c836669bec41c4039014ac712842b8902fa4a3431ee591d7696f90178050513ec06156ea08f9a2b0efcbcc873eca0810c32bafac41df80dec8501a1be87fd24b41a4844ec49e6087e63a6c61cecd6cc679ae15b3ca1f872b3804d9c237a69c9a7ae9155442a1f7f70bda1264207233d1443231ff20505a25ed5f6439fd914a190ba01312e0c0c93ec43b8073187f481869f1334989ab38ff1322b4bde8012b479e11c0fa509123217c0be2e607e9f8bd5049444538791c4e6b3c1047721f048641ec66df692a332dd6ae6c2bc99710c0a498724f7ff792a44877d4ed5981f2143987e6453e17c809500b193b4701ccfb71305f3d66b89afcf38d98e7033c7c71b77ec05a38430ece92c0c82a85790b20def893fc09dcc73b0844f1cb2f3bbf041cd92ee00d59017c210b774792441ae6bdc24f3e6392a913303dab5e29bd8446214def6b67dfdf53fff0569f4c26bf4100000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&minHeight=318078')
      .reply(200, ["1f8b0800000000000203ed9b5b5362c9b685ff8bcfd52772e63d79e3261c0542ae0227ce435e416940b9cb8efeef7b2e6b778bd5580db4754eed886d5444292c5332d7c71863ce4cfe71b55ad8d9d2fad5c37cb6bccafdcf3fae1ec255ee2ad0a49c139293149317d68944954d8c6b2a3d738a2bc998673a48cd0801cf157540258b100c24a5afbe5c05bb8a381225207e21f417223b147244e504f92f42c810af48112f00fc817cb99aaf574febd5d757b0c11fae72f8a0f57ebe9eadb2511a06fafbeeaeb6684f52a96e5b7edb1c4753b2ebf1b03eeece7795050eb8b1bfae7f1ff2ebd76f5f7e1f0ede0d57dfa50117f0341c8cf5e4b65cafb8d44b6c9b7fa69cc5adaff79a6fc3492985d64628a1bf5c3d2ceb0f337c70b558c72f577e6c1f66af63bf7ef7dfb310775739237efbdf2f5771b65a3cc4af337a37919e2df276a9d568ccca2fb2a2f7b56b3d9a55479381acf5ccddb2fff6977ff93a13f87d269fb01ef8c2fc7c961e1653fbaf5bae2837b8d64f71161e66a3ab5cb2bf2e716aeed7b99f8ced728c7fedf7dfb6da784d7514a023231c8c4e5a3b935cb28411498cf0d6336e7dd4c267570924865b812f651c1f46637ce58c52503a9bcc2b670895639c449622a18e06e2a50b208d0462b4089eaac835782603371152000b344816704d1c7e0b9fcf597e7a7b3ba5fdc9feba515e38a86fd352e437aba518172bbed5dd3d9cc55923df68c2a6fc7457a530f5add86f966a77bdebbd1c5ab19e3dca72ef6d38f1ca993e8333f57fc0d985ebf19371c68cd2de0a02121215da1b008322a682a644588632a6b80b2924cd8d02c151d14c00edac14d4281b8e7346725ce5b8b984b3fabab0bf1e0e262f2fb630dfefc7d48a749b7fda36f7dbda4b677cbb91c7d6f543cca4f4f139c6e6b4df0a4339d3853be6ebfdc2b8d170cdfcbd682cdf46d3b830467c7d952751463f95b263905db818c71983d3180b0c05c5780ed608e482782ec12763ad8d42f820984d347949830603567385d73010f45bc6d49b9619c21c47a2705c03c61ac2051146184922a7dcb1103c6a19152080e9a880b114a89634051685639fcfd86a987fbeb9af158ad3d5e3a0a9eed3caf707a8a2f5c7f2466fcaade1598ce5e7d39eacf1fd436d97fa8ffdf6a4e267b36967f6bcaadf0e2a0fe3746099867362e41952063f1eb2cb56e327830c9715474a311b9200d2c01daa940b5669c8c64a8226473c0e633c8aa8b05a29bc134af988718dc94f87ac51e66ed87e587577f356ed7ac4bbf2b93a795c14fbf78dfca65928cdc55990999bbb7cbe365baedbcbca64b215ad79ba2ff69fafb7bdfb4af477e3dd01649abfaec6e990b1ef4176f13c3e81d49f0cb26493b42a7087362b50afbc900c92768e2b1713184ea4e49a7b468113215dd4689149114fa8050eee0864ac43780e640ef84590150bab1d5b8e9fe0ee852de67d1e3bfd3e84a18acecee1a9fa7818a3fe0a317dd79bc799974551696f45a7b4ad6835e8f46e9adba4a1cfd94172369957ca33bc927c8fb00b2771295fe27b74692e4fa32bbbf756326f9552d6f084b908e383b08a9ba49205a112084d0dc626c26862c90941c1c33bba4053fa075d60a891942725a3234eea88ea14004731c6680d58430a008e4f309d680c04c31f4e842761183e618e6531e810c8652ac62ea28b4dd47dbbfb344d2fd0196d1eab0feba62c2df366d7be1e770bb5dd5959acbedda8f45cd6edc180ee4b543e6ca6ec5ed09766bd56ae9949931df8a4229984a9d3254c9b1fee9317aec611c89804751a6498b4598c3226c904a67fa235d78c582e9124acf998e0d6712645e04942c0d20f1f898abf0ffc4004fc0199cea298f15ef2e8b8e15298602d4f91729e32f10b78312112c3bd61f87812c9390556381f01f02f7f0b19fcc24887d21c831cbb10b2f61cdcd2a4752de6597db12c54eea6133ba8f72bf7cd1954ef2b6fcb9acde5fb1a561e4d1ab5a1efa2c9af97a5ebce50783e48a9789f57a316abd40fda170a32c6ce282b35ff2cc6b2791c47ec92b538421807796a498919c9196054086d494c3cf8149440e05420c814d690d2b99428c567d153a5f00e5921ef082382bc95948a730a91202f949ae44da28147afb0b46438b04581d3ca50ad928f447b95308469746524382173cafedc84d5d78be48a86df77f393e17ebd91153a698d58b1fb7c536da80d5ff50f5d522aa34e77492dfe03d8098031708a13ccf520411a5432cb08c721d007bd8b5293ac7906d46a4715f718f3846752f96059d2dae8f411608080d18b00e3b5fdcba623f9ca54fb55dbe8d77af5f5a8c1f72ff93437cde68b3de20c1f4a189fece4e398ee3babb6d4b0b7b779b3a2777303137aadf94bcabf0d46ff3c187d3f987832ae5fe44ff39bb2138f0defd6b4b05b37627b469f5d79f5343fa0356be6ea3368fdb4fe07fbc8712f5d8abf7d6f8e137f62dd415d562524aead47544954d2182f106aab7c42f705a28d523121ec8ea1c332af88563c7d4bfc5bdd91bd51b082c09b6382b391808a348a60f02d234079e79910828b2c2046aaa91722a2d2264731516209248e130f3981c4c38f965480bf32ed3c4691bbcaed6da17c1dba2bba8c9df17c3ef52d3e6889f6935bdf1e9ab69260ced873d0e4d38221fc7d4d7d5b8be384d1d30813c433ceac954441d61256044b85e429baae8a21242d53861c4b82cba83d5eed51785fbbb5ef08937f102685754c63a6141135c0e2509c319588769a63e5c2920f0a222411c039ac4210371c31cba6783f94953f3761f54d9c99475f9877ab167acdd6d0dcbce8594aede7addede0e9bf5f2810c6a944173ba0c2af31fc04e002c064e65602a0a69c0702d5cf45c7889052c135904044f8c4d241a0c0658ef266f7d54e8e9928117361e058ce89c60397159eb84f607f3e66dbf59e9f66fba1595df3ce6a196afdcef93142d5fa8568e6ee07c0005790f05551f77590a37f3feec69650a2ffb9ddb0d0722de2d9e96b071ed69ad22ebe650ecb4426f3c5decd4e76e491c65889dba590509ef2265ca4b97853009d66322e34e80c444a62563d1a1154accc889220b4e524dd0ccde33440f36ab0cc6391db9e59c87e824c9766c9c46aa9c8e10d15b851729309b70142b64100c4224f89fe0c6a394fd99216a3a94bd327451f0ab6f2bf79dca7026cad5d272381f540ad4958aa1e8f8b6d65b9686ba7c4ef02b0ef6b7d77bbe6e6e6abdfcad30bb627d66179d52d796edfe9ab5f9c15ed52b19703a19f253b7448f6e235cb416c708437339b1c11b503b700d84f4163d0bc58aa34c51176348ce99443297529a450422ea609d1259ed40bf210cd89b0d5ac5104665b32d502703cdf644136a16e5100d4789d2415a82c373e2b3da0693570c808a6835b7341e278ce458f6efff9fb0b2791c5d8bcebc29b77950bd8e7ee93ddd3c6fc26c5defdd6e5e6edd21610609a3671026ff8d0853276a5834cedb28057a5d324118871526d8a059b2c62a6a8444b1b18a88e41db3c078e2688ce69be215ccc1c10e4664f0991146e6bde054a16a31117466b22978fce514d1003dc14b18c5b0252c533a319982c34b8f10c63a807809cc5a17f960e909549d979e7ceaaad1b6f5a877e3a7e7ca5db3aa76bdde52e48b673579f7fdc5f5242df4ec6ebc59dda00e3f8b7d1aed46bdc5605b9a3d944a871bee0211e36720c67f7c93f7b2d5380219bace894d5ecf0222e0d113b17273283c142b39474882a8530c2e882c7071a282a2d44615a20782be76081918066f4d5e9f69a3b2ce62d6d24c4a23b2ad08445930661d3e1c29498c53544e163d86302b28028c210cab00c6e5e74306722ab7755a7c98d45ba1e03bb57e1a8d6e68c772b719f875e5facf5b3c1fcb989ad71f9f641142a5c6afab4fa2b2a483c87793da0af2dd6a73b73f648c2063ec0cc63ead07273e42eca2b5f8d9088b4cd06c4494252f55d6c5e00c32d27864ca59a5bda768b5d640e45110ac14699489698c8f0625ed286184e598cc09f1a38df22f7742c5666fb6fb6d6731daa56e5fd7248cb63b3b9e551bdb9e693e960f4f0d3140493f631741b24f04ecefdaa4f82e5efa44bc92a35805626917854e96e26b318162aec78cae65e4099fcf5ab6c9078de8612eb79c3890e93d5e54bfe16562a2040b468ec1cde1b5d1eb94455e542f2e0380678c382c0310379310388b062d4c044534da2b3996c368266084e7d865d522beeaf660b3865d33b69bb3a721ef357a43d9f1ad817f9eccbd9d9f819794f5c77c5aa5fbbd9bb7b785c5f8a6fa72b75f3c6dc6fdc2cad7d2c1811b9ce2393b08f2bb05e08573f811fbec8267ef9753e032497182f868071a137c325c78bceddc4686c90c3088794583a01468667b0419908446f30d5c40def60f7830583480c3fa4126cc75c4706435219b8e0767a21752a0925116b9f64a65b523b1116b0742943347b40b64b67f20488e921f7d8ae32f437e7ded87cde2a2cddb6259da4d1f9be1aeef57d5f25d5cc9f03092cbd63bf142773ca39b2ae193ce71c0671d14fa903049d88927399890d107ef68088c7a66744a8065a5d154021598ea6324519a10826501944a3401e8a4de11a6257b3bc9211944b43ee97c020341397444ea","a940d9c320af98c512d26a9a10126b58c633e6af8891dfe9e02c83e384418ee81c153f4119394b4ddba8349b6e30d55d368d2bd6ae5e27b8d9377d61d4a00701866767574ed72f61fe6d8a4849f8890a0618803466a54089903209998c53413aee84c14acf8157315ba6a06df08ca0a2314a51f3bee18b1e2818860e41ad006248d6e840418b31eba306ee31bd31a13920519c667d10e44c586750dabc88c4e964d851be08e4805ed6089b2e36cd16e5f358aec2feb9d18fe556b9235bb590d677ed8e1ac4db73dcb1b4f7fbfa75afdb2c38da44a7e8d54c273f9a6c6eb86a8d07adf5a17e5185aa7cba7e09fd63c3d7450b710c2ee02776285ebfb8934e673becd41b99b4d73aca60c11a639104c032db2992f558858d243b7061bf814bd0b70e855786242e9563d26874495436122970ac0d1da7de738f2eeb505e0dc65ea251d3d02891ef10a3e6de1ed96c0491891727392e2f806b06dd55135ee2c356a8a1db8d6e36b3d9ad9a77681cad5be2b13b6b9cd564f5d3d21d9f9bbd99b566e33b356c869abf73cd62afb92989c2e2207b65e7eeced80812fc076bd7650b7194ae53c3d757ba5048acb35c04d417896522759e807e3d7891695522d9c692a398940cf88879ec1b6b1407e18b5b2c112c5a1e4918b9188b59470d9d8f27cbb952dcd3e4580ac0206447ceb2b3b6108d0c5a587c9ffff903274817cbc2176797d135ddcfc62f21dc74683e55aa7c920ff9e57da14faf1f56b492b70f93f5596737182d56564ff73cbee4d5446d2ba3c578d1df895bbddbb759a1583dd42e46199cd1c217ec07f375d9521ce30b2bb333f802ad911eaf740402ecf5534c217986210af50a7931912a04cb39458da298a4f8fbc68446b7fc832f97b5fbc15b2d0d101993d28160964766ad45f57280bfce1cb7afa7b605aa99f69105cdb5048450c271beb0726439d0eff862a77e40f3f43ba3cedb65fcce898a6263f3c8596fd3b897f5fda8d32e71d19c4e1e56b77761e5ae07078d7e4eb265fdfd567e42b4ff05dfc6ec6f877bf5518170f1d4fe4ce9a9bb0086b3e04426401e093586530159db14ad109c4c5699146c006a830b0ecb45ed0164a0f63da587bb0098f7bc4ac87d76e28a314b9862cc61d110b4cb9a278612f4548ada8b828a3eae957358df6a8955b005c18e528a018ee90bdb67e7dc604eff5a07e36ebc1f15fd6c506cecf6506c4ff35b256b1b59ad4ee77ad3bd3fd4414eb3387bba0ed24f0295d3cf28425f47f9b80a15a76e974702814aac1933a4b2cf6ea290911448f4310b5d22a96853d432532b86253b560dda7db35d0e9aa8d784bb5cd9c5d77bfcaf4951ac8557f395fd35fbf6b77f02b27588ddde3e0000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      return callRPC('listsinceblock', '00000000e01d2696b1b6fe51883e0fd0ece2cc45f7eafe86e3d839571c78b7cb', 1)
      .then(function(result) {
        result.transactions.length.should.eql(27);
        result.transactions.forEach(function(transaction) {
          if (!transaction.pending) {
            transaction.height.should.be.above(318078 - 1);
          }
        });
        result.transactions.should.eql(results.sinceBlock2.transactions);
        result.lastblock.should.eql('00000000b983bde4a220ed5ff88d8bca741278b8e3c6ea1b547f79c0feb7aa19');
      });
    });
  });

  describe('Get transaction', function(done) {

    before(function() {
      nock.cleanAll();

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx/notfound')
      .reply(404, {"error":"transaction not found on this wallet"});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx/c1cdd3653d6e7e2ce43e88d3a44f95d550f1fa800c25139d60125c668e563dfe')
      .reply(200, ["1f8b0800000000000203ad935d6f5b370c86ffcbb976078a22f5e1bb65dd52aceb902d03ba66d8052591b69bc44efdd1b428f2dfcbd3a4e8b6eb090738c712f9f8e52bf2d3b419d372eaa18f1113c791342b76a5a8a58c284456793083059302d09143ac234140ee2915e51487e9b498861cd54908819f013e0be58f004baacb80df01c09547987a8033e6b59876a7e3dde97898967f7d9adefb8f69e99bd2fbeeb43dce9c5f319c1df9eaed6f2bd6d73fff727e5aaddee073bb7ef1f1c3fae2a5c8eacc91efe5e6e4d0101fb10f8bafacf06fd6f3f2e77e75f9eafc777c798b173b79d77fbabcbb5cf39bfa63effbfdfdc76fac92f051e0e6f06ab3f58de3fea40f7f2f26dd1ef71b7d14fc3fe8fc27e28ccff1ededbbcbc3fd75fe81305f6d5e9cee4fdf1fc3f9c5815febb97c433cc3f0c470497db7b5cdfe568e9bddd685312fa63bdd8ecd76352d4d6e0eba98d6fac1ff02c2a3ed10940d861204a38a896ae2aedca3dfbc24ff6e201c39110ff0f39c598d2bc614a40a6473023e826cd898df9423100122a408a59b884554cb586a684e4bc295aa7932a79c7aadd625b2590ec34f2b71699453c25c6646464fa6e2611462eb8503428d7daeb92669adfb2601341b1db2e4d6cc0b08aa06da0c9b42a0e27ad8595e71cf025e531709d65a224bd56a217f2008d030938421c6a1ae331946514ba8c18b0b23bb51b3a2d8874a6c5c214a66502de0568dd0ba4b0f146370114544d83468ac0c236a9792731d82e28a7aaa3cebf1c8514c42072f66be07746b34923b6e86094d0d59213214322ea571034c3088b516df485f182e2d153463d511038dd854a80f40f755b955a8d547971ab8b2227de40ed84c69845c03aa33104b278b5c889a7673eba56a6f25d55247e48183dd3b1065e69c912aa12322d76e3ef77ea93c1bf5b400092a8ea7aef8d262596a208f0ca53745d261b517f40eb268dd4df6b3d806958cadb94f0a25fba5fd277f48d0c25843d53cdcc9ea6d386a16b7888d8ae4d8dc5af1fcaf793e23ed66d7afd77258cf2dffb48c53e7114d737656556c442a7e30c0bb30a91b5a804af3aba328a3e464dc460ad33c3b9bd5da27346224e087cf008362ad2c050000","ca81eebe6173470f1de992d03ec508831fb18f61741902af38ba68c5ff2e8c98b60efc0a1a1a174ac8681d0a145296f74658aa7580c6c6bc94d231cba203231370ad0347635271e13e1fa34a19533d69d05def3674cbacb65c372bc97c35af2d211acc4ad5f607306a573a7b49ae7d6b36eab93ca95566a49c26f561b956eda5799a8c66271849d8304c3f86d1a5c5febfb9113433637c3410249587e60691dc49e49080bb117ccf95863e169c6522c20e43b783c845c0c020d62b1cd4198c548f90229745842fc1e836c7fd34d9a941e5b1a2e46eb18ef96d9ac4f0385d97568fe5eb5eef7957f1db6e745bab540ea5dd6cdbffb61d37f3a69db2e6ec6e559fddbb6d9efaf40423adc499d8ff4956847f6245972df71c4392bf8fa1a717d186588e8e515762ab05a45d29148623955c04c31d555c496a0872562049b543af1842ec0f8662f04807c28d501180e35138c1503010a91503a8744026586abc01c362e48898951e3294351c823e3bcb10d645c28ae8e5b8a735219f3bede18f0d7be5da7e3c1d6c862c5f4c784c461b7cb79b8def1296dff4b6ed16bf7e56266f289353e5f9375ce9dd89a660b359cfef4bbc1fb1ba1f6d5c65361698c1437c52b2d05aa36332fd1c36e9597b9b4f87244fd29693cdb0bd0b497bfed8e72dbd9f2662bd29756f86fe84ee9f04ff8b57f51a6e8dc9fbe0669146ecad608663267c448ed8688817d8c274e709c6d86b167c90ca092a1c974c6378025ec24d857c8e6b607fcc0bc48313484786ccf11f0b05a98c6bb05d2ddd1167182c60ce50f0f39e6304f1df69cca2b7f4a7702380fb923efb9173797b7abca19b5abddfa5a277e8de34e6ccd27abf31ac56fb83ebe63ecdf3eda93f424ca5e89f4b6be4bc455eb6e0b310bdb3cb621c893afe45a090331e080a8e78e51872de69ab88e416a9a03ce790d11d78928a31e2a7a37e01d17397853c068321963079462610f8ab877de430450285d2100e64226a348b0089935887c024a6c7706ca97beadf672052450610891710c10e48f9b916493e6291f3c9244d3acb75a79c947a9d45354fbc6bcc77f5b5cefc7dda5c0e4fc6484829b079f493f821e72de8827a5e79d8065a5532bbe9b5bea9c3a862b269dd37d24df3710d5c8dafe9f40461fa97f8b1f7e107add11a8a0d65cc19f033c7b4571a68210e51c15934ce181b20e7bbe8558846702208fa9387f1e75981dac021e2f9a0c0111d8cef5140f3c5282012e19d1a2bb8c25c05860d487a6db48f029a33779246f67efc28e64cbfed61ab764c5a713315a65ddf55a89e75ef7832da2f1ffdf5a1b31accc3e99f4a8ad29ffad7473a3d39f6977f2ae0fda1fe8a9e4b567a72fb21e9cf74b7563e6caaa95e09b9da841b9dc755b26f87bd20a27c021fa47ecd18d7973f005ffefe1380cf3f85f376ab5a6d35b3dbd2808d5a215bf553711836e6ade5bcd4ae6575f1b6c4ae520bd36ea058d1fa38bb49134ef975af761b9687b83c7437bd7312ff8ee710aa5867263de24b8e053dad080388d932335f61c214df7f05a50201f94b190000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx/a4dfeae89864f26a7e61c843aadf48c6d64b0758c16d0ba7b8823026ddbf0883')
      .reply(200, ["1f8b0800000000000203ad9551735c350c85ffcb3ea78c2d5bb694370a4c18289d76606829c3836d49c9a66d529add964ea7ff9d7309292dafe087ddbd77af8f8fa44fbaef777bdb9dee46b5f0e1a2d26a501bdd5b5e52cb18165556b35667ea2c2b374b73f429422551339b9144caee6467e3e050a294f95ea27b597ecae9b4ea69a62f524acff044381ec8695b27bbebe3e1d5f170b33bfdf5fdee0d2e76a7b839d6ba3e5e1d36998794ef1ff8d9e5e373f627df3d383b9e9fff425fc7f36fdffd71f1e8fb31ceef43f1cd7871dc348bfea5fae1e44e2b7faef5558fa7af84b2d39bb3cba7f1cb7eee1f5cf1cf67cfeddd78fb60d1fc44abd2bfb4e873ad72f9c61f55fef232f72797df1c5f3ebd79f6ee41e787263ffe7ebe1e3f7cfc8f562ba9dd46bbbff9617f853b87d747fff0dbc9ceaf0eaff77e1bfdff10f4ff10eba712f7f98c2e5ffefee3cddbe7fdab4afdd9fedbe3dbe397877cf6e8869ff8d9f847e21ec9df1a886a5d5fc5fef5cb71d85f5f2136e693dd2bbfb2fdd5f9ee34c68b1b3fd95df81f3822dd529012c5e0aca3c7d0d0a2b9984775579a1422968af4a16c75b6a853868d146bb29bafd57bf591ee5658d8f65da5a4ca89289152664d9ead4b9a46412baf411cde1cd84eab4d871b4b445ab4f1dca87bf215736a3581065c8626ebab8d284ba6f6a999e758e28bda6c9d92d5e125d01945cc9acc28a5ae9e4c596b923653ae1d8eeae6a82dd5952d7af1cedc666dad7131e3661597793bca79a9e9f43a44a75a0d1ba1bd2a4bde1c25b6d573567332acd61ca9ccd6c21165519f2bbada82bbdc58bb08e7a80dcf2bf952f1cdcf6aca5b6c14daa298c81ab5484e80158588205735d42331c1daa0b67a19492b95be9891fdd509c3c2daa6a1d8a8388d99b291b551eb684cade49274722e2d5834da6ac498155a3d46711bde2bfca328387726c1e429255611fc39c956827fa4b2694e18353574a020b38eaeb820032c9eb5b3a27638ba0c8fbbf55f79ca1f798abf785254afddb2b05a88337473f02cc9a5a18659a8f7c095a366a9018ed14b4124699074e5b06a63cdde4afd4814714f7dc03a26a9566822596088ba29f6955238a7ea35a210e709e05087e53cb850302af891f1c2211de4f74c0821fa44525521e733d660499a2660c5f39417c4cc1b52d639418f96ac5b47c8de6c59f24acc52aba43459cbe8a02b2fa0a223902b422d80baa152ad0ded09e1810699eb53a6943bb04470d1051dd63296d4ce9d4d6b080a99a4644e188d1ba7300f5fbde429bda319f3a6918016720aeaeb421e6666e1155e5a05a0033fa55aee358fac782dc580aee4895c46c9191db169486938242a6b6bab4ee0271d6fac49c5b8d2445c15c9c4ff81a324302872998e0e402f8c8a847fc2542ae83244f371d8a40c8a32b0406c6b3a55b7d085990bea403141a1016bab3813bea4af341600fed7fee5b1f91a038e7c6b63ae730c1a54f2c044f1d19cc27006e64c91858fcff7236d687b97b15a6f35013a4f9b0fef68e195e17f95ac984cfd6e1fe6f67c71bd9e5f8c9b8b6d0cdf0d4fe0c056c27bcfeaea34ebed6cb5843a8202c3f0a932bd28b263d2d1d4d35ade6df37c7f7e81b74621f0cd1ffe04fcd737d04f080000","ca81eebe6173470f1de992d03ec508831fb18f61741902af38ba68c5ff2e8c98b60efc0a1a1a174ac8681d0a145296f74658aa7580c6c6bc94d231cba203231370ad0347635271e13e1fa34a19533d69d05def3674cbacb65c372bc97c35af2d211acc4ad5f607306a573a7b49ae7d6b36eab93ca95566a49c26f561b956eda5799a8c66271849d8304c3f86d1a5c5febfb9113433637c3410249587e60691dc49e49080bb117ccf95863e169c6522c20e43b783c845c0c020d62b1cd4198c548f90229745842fc1e836c7fd34d9a941e5b1a2e46eb18ef96d9ac4f0385d97568fe5eb5eef7957f1db6e745bab540ea5dd6cdbffb61d37f3a69db2e6ec6e559fddbb6d9efaf40423adc499d8ff4956847f6245972df71c4392bf8fa1a717d186588e8e515762ab05a45d29148623955c04c31d555c496a0872562049b543af1842ec0f8662f04807c28d501180e35138c1503010a91503a8744026586abc01c362e48898951e3294351c823e3bcb10d645c28ae8e5b8a735219f3bede18f0d7be5da7e3c1d6c862c5f4c784c461b7cb79b8def1296dff4b6ed16bf7e56266f289353e5f9375ce9dd89a660b359cfef4bbc1fb1ba1f6d5c65361698c1437c52b2d05aa36332fd1c36e9597b9b4f87244fd29693cdb0bd0b497bfed8e72dbd9f2662bd29756f86fe84ee9f04ff8b57f51a6e8dc9fbe0669146ecad608663267c448ed8688817d8c274e709c6d86b167c90ca092a1c974c6378025ec24d857c8e6b607fcc0bc48313484786ccf11f0b05a98c6bb05d2ddd1167182c60ce50f0f39e6304f1df69cca2b7f4a7702380fb923efb9173797b7abca19b5abddfa5a277e8de34e6ccd27abf31ac56fb83ebe63ecdf3eda93f424ca5e89f4b6be4bc455eb6e0b310bdb3cb621c893afe45a090331e080a8e78e51872de69ab88e416a9a03ce790d11d78928a31e2a7a37e01d17397853c068321963079462610f8ab877de430450285d2100e64226a348b0089935887c024a6c7706ca97beadf672052450610891710c10e48f9b916493e6291f3c9244d3acb75a79c947a9d45354fbc6bcc77f5b5cefc7dda5c0e4fc6484829b079f493f821e72de8827a5e79d8065a5532bbe9b5bea9c3a862b269dd37d24df3710d5c8dafe9f40461fa97f8b1f7e107add11a8a0d65cc19f033c7b4571a68210e51c15934ce181b20e7bbe8558846702208fa9387f1e75981dac021e2f9a0c0111d8cef5140f3c5282012e19d1a2bb8c25c05860d487a6db48f029a33779246f67efc28e64cbfed61ab764c5a713315a65ddf55a89e75ef7832da2f1ffdf5a1b31accc3e99f4a8ad29ffad7473a3d39f6977f2ae0fda1fe8a9e4b567a72fb21e9cf74b7563e6caaa95e09b9da841b9dc755b26f87bd20a27c021fa47ecd18d7973f005ffefe1380cf3f85f376ab5a6d35b3dbd2808d5a215bf553711836e6ade5bcd4ae6575f1b6c4ae520bd36ea058d1fa38bb49134ef975af761b9687b83c7437bd7312ff8ee710aa5867263de24b8e053dad080388d932335f61c214df7f05a50201f94b190000"], { 'access-control-allow-headers': 'content-type, authorization',
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx/44954268b32d386733f64d457bc933bf323f31f3596b90becc718a5b7cbfce8a')
      .reply(200, '{"id":"44954268b32d386733f64d457bc933bf323f31f3596b90becc718a5b7cbfce8a","date":"2014-11-12T22:44:43.000Z","fee":10000,"inputs":[{"previousHash":"a2d161ade31a49fe8a205f77bd70f1bca1e85719d945f28c488d7e7bbd431080","previousOutputIndex":1}],"outputs":[{"vout":0,"account":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","value":100000000000,"isMine":true,"chain":0,"chainIndex":0},{"vout":1,"account":"miTkUwNRBYinuUALY1EJEiGH4tenvsUkGZ","value":721187660000}],"entries":[{"account":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","value":100000000000},{"account":"miTkUwNRBYinuUALY1EJEiGH4tenvsUkGZ","value":-100000010000}],"confirmations":300032,"pending":false,"instant":true,"blockhash":"00000000ef154b1503d84244be056807261d4b0bf1a4d03383659133de2668f1","height":307993,"hex":"0100000001801043bd7b7e8d488cf245d91957e8a1bcf170bd775f208afe491ae3ad61d1a2010000008b483045022045b1583fa9344bd94e492e63f66b4e3974e9e7f65aebd0e10b5795c872174733022100da3fd915ba389456b0df2cd2ec5d0e15ed149bf578c2a8240b4d6a54e8291997014104122d779d21ea2c6ef55edd219eb71f659c0d107e27a5aba7075c1ee096b05afc4800ed7359b484fddc586663a7d911abeaefb3a3d1b7fcfd297ef3f4e9fed267ffffffff0200e876481700000017a914b238b35dd6399962fbc746f467774c2cf4966a5d87e06022eaa70000001976a914204d44de7cff19e4c0464b92fd2e9ebd72596a2b88ac00000000"}', { 'access-control-allow-origin': '*',
        allow: 'POST',
        'access-control-allow-headers': 'Content-Type',
        'content-length': '41',
        'content-type': 'application/json',
        date: 'Mon, 30 Nov 2015 21:55:36 GMT',
        connection: 'close' });
    });

    it('tx does not exist', function() {
      return callRPC('gettransaction', 'notfound')
      .then(expectError, function(err) {
        err.code.should.equal(-5);
        err.message.should.match(/transaction id/);
      });
    });

    it('single output', function() {
      return callRPC('gettransaction', 'a4dfeae89864f26a7e61c843aadf48c6d64b0758c16d0ba7b8823026ddbf0883')
      .then(function(result) {
        result.should.eql(results.tx1);
      });
    });

    it('multiple outputs', function() {
      return callRPC('gettransaction', 'c1cdd3653d6e7e2ce43e88d3a44f95d550f1fa800c25139d60125c668e563dfe')
      .then(function(result) {
        result.should.eql(results.tx2);
      });
    });

    it('instant txs', function() {
      return callRPC('gettransaction', '44954268b32d386733f64d457bc933bf323f31f3596b90becc718a5b7cbfce8a')
      .then(function(result) {
        result.txid.should.eql('44954268b32d386733f64d457bc933bf323f31f3596b90becc718a5b7cbfce8a');
        result.amount.should.eql(100000000000);
        result.confirmations.should.eql(300032);
        result.instant.should.eql(true);
      });
    });
  });

  describe('Received by address', function() {

    before(function() {
      nock.cleanAll();

      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/address/2MwGWTGZn5EHDsZoYGB2bDCdCb4wLVsDZ8E/tx?limit=500&skip=0')
        .reply(200, ["1f8b0800000000000203cd9a5b535acb1685ff8bcfc9a9eed977dfb8538094c845e4d479e82b021b502e82ecdafffdcc957db205a39110734cca2aa3c264add55f8f394677ff79b65ad8d9d2fad5683e5b9e9dfffbcfb351383b3f338a7b1db9e59c87e824d14095d33230a7238d3e39e1450acc26e59d153208464324f84d70e38976679fce825d45ac04848acf847e06d301762ef00bfe450819e02b52c41750fc817c3a9baf5777ebd5df57f0803f9c9de32fadf7f3f56c9555b9d854ae3b95c14c94aac5e5607e53c9832b1642c1f14da3b72c0e74090b3ed83fd65f4b66fffefaf4b5183d28d62cdceceae51d5fb71e1abd5c5d986de16266179d62d796ecaeccdafca998a65a31bc0725f45ffff9741667abc528fe7d9def50f1d3619592190fcba2336fc94d8eaa5e473ff6ee6af70f61b6bee8d51f1eebeea9ca674d0d968117ca9cf6acf0e6fc7c96468ba9fd1f0c8c2af1e9ec2ecec268363c3b4ff68f65fc74e6fe98fbc9ad5ddee2477d7d73089c09bc1221bd25d64ba2b8540a5c8c21396712118247a559445ea20ed62904c629c0ebb88da3e12d5e360302946577f2054069154be095e54a05270380d03e452181d368b8274607690996e7c41362ad6722061a42b29a5b882f0348ce59f6f5f100fec040ef8ff3770054f38bf19d2cd05069f072f54e54967013f976d258d15cb7dadaeef6d1018225d94f12f8ff00d090e3008cc6791ba530284b2608e39877d406cd923556811112a5ca2a229277cc52c6134fc61872082035fa1f007d640298175ea6e0a54a4930cea894064966ca59a5bd0744d81a1a791484c5085126a69921860afb0280ac43d83993e742fc6a00c55bfc89879dd9ec369dc5709bba7ddd9074b8d9dadb59b5b9e999d6b8b4dc1b66468111fd067f176b3f6815166dde16cbe2763a6e85cbbe5f554b977125c368289757fbfca1b230625ee2efc40b3b9d3ff13a7e9c12751c7ec9818c5a4511854e16f0524c002915b64e2d234ff877943b9e7cd00aff1084e5c45199f6f1a306347dd23f4623b2259d4fd4d0a01c22071e04be2f31a99845edb31a1212640d13de08013e7a820d3a38cbe8b7f851d9017a4ef43988df40ff66a9659b9556cbdd4c75974de38ab5abe5446bbb96cf0f9b507e2ac6719eeaaf23f49afa9d54ef197a053f2d5ef2b9d999d9d5ecf6520d5aa1e12f5dabd06b3d14457e31d82358984c3dbe2df25ecac795d4c7a147517c34ea540022a44c4226e354908e3b6194318e7a15b33b0eda06cf08ea2103e0841ea0a725907fd0b3dc19e50349c65b2fa2f22605c3a2499c2a1909939e81f19e2490c24949624075b589a48cca64d5b7e811dda1ea9cf373c24e406fba2955e2b81df13259f576555cdca0cdcc752a1771be4bf35d7bddf9f699be02de74da6c94cb8dfaea22dfe7c3465cdd75177237a84d1bf369be595955e5f74ac13313c9e8b23248c3915aabba7657f3ab3abfebce27a5bacf6fc61d3f7faa055f69f98e80fe00399ff7f5fde7efeee71ff53b3c966713401290c74d00e3aca43a22f9e811d124c6448521120da28f562b0ed184c4544c5c0b070cb815d4a5a80f26806212fe99000abd02f2ce4460c911546f8651081c211cbf71ed2111ad92a7e837b4893226fc4532e8457d223125787102108393fab4d63fbd5f076e6e26c54ee35eef8625bb1a57436db1ae5f2ff161dde6d8f8e8090017db581b35447ed2053d28ae1762262a0f8dfc6cd60339673761d1d86bb047507b4ab943e44ebcb953a7cef75417a139d26f12419955d408a70860caf19a0b08a08845eac059821d393a128c0534a4d8c4412994e870081decf94d93345581a3f0472b45908a62f4c15e6e3c934e6bcff1d506dd04e628cc4332524d39ea2f210a9d8412f435e800a1e31f0c5d33b79c73a72ab5d58dce77f4b4d39ccc58915f5f754abad72dd6d4f50f417752b9df193a7a64cad601b32f158a02ea12238244ccbedc69f04e2b48d132835708cc46169cb62258502e99e7d0a927e89448a00d630630940b8e2615838ea28a332719c10f8916733d2732f1e89dd58c015a5b41d12f5026d9cbd0e92fd0d18f864e2b364bebc5706e247fe0b5c15d7f5b9283d2b855ee36f9ddceb6f66a1d43dd49f53e143bf83e76fc48adf38804763c455208de623315126d01f6532594b29a33a359242e588c1fa85f3404cc3c019e63c7f7b235d52128a60cb040946359844a0ed33e28143dc95cc29c2df02536442f217a2dbc324944466c14af6087e1469d53f3abc30d9ae7b7c833b27a7b575e987bb56c894daedd9d0d0a97174c3cfa9b9b61acdd57f7f50908636f2e2f9e58f19935532b283930939b5d7b3a2a70588e58bb5b0c9d346f37afec7adcde63c75089657e767567ef61bd8020e54722a88332ce60fc50847aecb454486505a3560247de34e7a88104fd5af4109028e259d67cd33304f913824a719f1cfa3b8b97e898c3468b5d9c1b2730b7bb2ca6237802120629240eb9240a390c31117cb921fa650449e6f1a8fee5088a3711fc81a1de1fe9ef38bd5d87f9b9e43dba69d7ee2f37e3fea8bf9d76379d7e6ed8b74c9726fbf0708a25d94f32f84e088aef2378e412b74f8160264e94194c185a9bcc9b316515b786d248a3c852b40e38f5500695665a084982788ee0d312b7c03862f0ddcc702753a00c854fb1646422215b40c2608d626a4310012d82b53c613041cfc788e61837ec6b08662a283f7c89e7e2b1cccbeb75b92297d7f9d5f8b2948f1722fa5ca9df1f2c57ae301fee0d34793b689c52ee197ae54a3e592f7bb94dbf979faceb8f66d0646ad1aa5d751e7ab0be59ef3b36437fbaffd2ef8377e4da226608f472946290409fafa30d924a3479980302709c22c6534a032aa14d92a03704c73984f81cbca7b5c5e48ca60e030a4dc4a82c0c27405ca9c0f4e2c062d8c0f01b0903c3b053874895c649a4d06c4a9f22951f0a1e8737b756965d515edc7b43af8af33bcfe57653f051c962f531372adaca5e2dfdb6eb3ba5dc3364d6f99b5103ba8deb07a0b9f6a63e6cdcc7c7f18d432bc86bca6c0a076df7a7b1fbe709fd5ed4c9189841a8a4a75627efa38e089fc5a04b944af8566da531516a500c824f3a58cc1c88a3e42a292d0ea8e39f297c6634cb1a549c33f9e11b2ab9759ef756ac3beaf075aff9d8b9dc5e69d1cda5a26185f9a47857df9327ce304abcb5a1d214b1663bf345d3d59b83d2ed2cd6ae0737bae5fa9b72b7bd1e4f86f3837ecbb175bcb8a172e285fd920d151cd823bb2de1110547136f1d1abe284ca282a125f3841a24063b6ea23ea42443a049a13b049234c061e690443e755b15039509610a1820b446e5436b4a2d379653e6b3056f2e2d3e46703e93464ccf5907cea288d052f2f82d7e001d6ab2556dfe1b6c28b37abb7e797b3fadb6abc198a1ba8ffd95db8e1e1b2637be8e95e1c5fe3063b6e2ea2dbfb7eca782dff62a9bb6cdc1b49ccf170a6397dbe63af3c26ab5b9badf3f8b6044b6c3ff1239a75ed8afe9ba9a92231307a86c9b4e5a1339498c5bef50f20ce6cf28824e08a14b0e126298304018eb138659eee5a1fe09d04f89c3499054787485d27330e81593220e9f59488646896f56102592886d59b044903a94410aa8b2a02cc86f01a45f16f8187e7dfc8ede8fe0b24fcbfb00f83a7f27dfe4c122f743ba2d8e1e276cbe7c7cbc9ab0dc76d371bd457577bf19ebdb7a7d7c3015285e8af97a73cf01444d3a724b5904cfa4e03244a71547290c168cb52e8b0da8493a86102d844c07a9373e28ce8c4907271ab0dbeba76d0d60d2d218d1bb28028ea1a7f341673a8a2d9c48640a91c62ca3acd4c62500aa49e422dac8581068fe9e0348330001232f3b672745dea6e9d9026f17af9acd59e95156f4ae51d6c3597538b9918d9eb95cf67f684b793eaa75aaa3517eb1b90b57abe1bc9fdfde8c73d3bbe160472785ee760f972356fb4ebdb69fbda45fb4dc47d1201c297dd2a1c451c9356a9c75e8f7a90a880bda39996d94d16430e8a22a6921b95446701ea850f2606f831844e449fa30c37a40e974a86858ce272fd1d261230ec898c1542dc01a4f4cb291e8c812ce648e9aa7f1c32315e9fdc92bdb7871db4da5ce321f4ae3de43bf9f2e1fc6a237e597d58aed74f6f7397164e49b29e1f891fefc1e43fdda198653efebb7a24567675dacd2ce38a53d660863d0dc4619ac88d265076020309f7937e323219832f03b53cee1a7c5685ea4059d1a39f1fcc18fad36bdd92877b3fb51aaeeb42d8d6479121b6e359c0ef56ee174989446cbd1dd7e5bcb16bfd89b2b73a7557c86df6361b15a2eeeba93729d8dc2a8dd7b4c36f8527df97859cb5db74af2a0c9712cc17f7665ee0dbd624766852fc7601cc554eab13f3299d0ac798e7c60bf233e7aec73312a001f98d0296b6dd1266d9f13289e4ec078160847d1ca1a6222c1215b685e913c115524213b43c02d155178e213643f3865d0a631e11306e31708645f0e5fc973f2cbf7278e382e7552b9e7b85c74fc54efeaa156835279e19a838bb5c90d078fd3b57c285552ff25c57b619c0590233361b2d97626d3067b49e43450104e2862854be8a0bdd4411bcc78c172c129a6419188a752b98371d6543f654212349a27743b462b9af9219c1d04a2e792a13d4a4210990db3e2980b71cef88c2cedb2035534388c862f8c3364a7dc516938fff84c58ecf3fc653116b76d51bf1a2fc70fdd66f9a1715f5a14db71d0ba15ddfd51d6ef6c8a9ef6bc5f6853275ed9af098554b063b74205aa8bf02e1a4e40338ef31d74d6e8d050a3a141c1c8764131c991209321de2624d54be70f1054666f2b147ba7d080dd0b454411e53da63eed220a98b22405243b5896d0293920c094b0d9e9128b81131c3a7350ef8fe00f4c6cf3cec7da5e0d60275ed3ef34d0805a03017b043a21e1d1ce088c6111d018696539c3e1e7e87735048acd247a150c2a4f303c3b81a18cf72f0f349c033f17fac35d4d936eee6acb876a30b76a55ba559d5da1b9b8e2f785d1202f7bb5f95d677f84e431477a4fac78bad27c7e1fa98137a4e6c81366425847984e9480492c302975b254f16c0d14fd88e1e8b3312ea1d93690edd808c4c44aa79f13f8c5392e5776f13700ffbb25804f67abf9cafe91fdf7afff02d3400a1306360000"], {
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8'
      });
    });

    it('getreceivedbyaddress no args', function() {
      return callRPC('getreceivedbyaddress')
      .then(expectError, function(err) {
        err.code.should.equal(-1);
      });
    });

    it('getreceivedbyaddress bad address', function() {
      return callRPC('getreceivedbyaddress', 'foo')
      .then(expectError, function(err) {
        err.code.should.equal(-5);
        err.message.should.match(/Invalid Bitcoin address/);
      });
    });

    it('getreceivedbyaddress', function() {
      return callRPC('getreceivedbyaddress', '2MwGWTGZn5EHDsZoYGB2bDCdCb4wLVsDZ8E')
      .then(function(result) {
        result.should.equal(62.4198);
      });
    });

    it('getreceivedbyaddress minconfirms', function() {
      return callRPC('getreceivedbyaddress', '2MwGWTGZn5EHDsZoYGB2bDCdCb4wLVsDZ8E', 3200)
      .then(function(result) {
        result.should.equal(60.4198);
      });
    });

    it('getreceivedbyaddress minconfirms 2', function() {
      return callRPC('getreceivedbyaddress', '2MwGWTGZn5EHDsZoYGB2bDCdCb4wLVsDZ8E', 15391)
      .then(function(result) {
        result.should.equal(1);
      });
    });

    it('getreceivedbyaddress minconfirms yields nothing', function() {
      return callRPC('getreceivedbyaddress', '2MwGWTGZn5EHDsZoYGB2bDCdCb4wLVsDZ8E', 16000)
      .then(function(result) {
        // TODO: fix JSON-RPC lib returning null here
        assert(!result);
      });
    });

  });

  describe('Send to address', function(done) {

    before(function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
        .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81873005758,"balance":81873005758,"pendingApprovals":[]});
    });

    it('sendtoaddress bad address', function() {
      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWA', 1.00, 'bad address')
      .then(expectError, function(err) {
        err.code.should.equal(-5);
        err.message.should.match(/Invalid Bitcoin address/);
      });
    });

    it('sendtoaddress bad amount', function() {
      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', -1, 'bad amount')
      .then(expectError, function(err) {
        err.code.should.equal(-3);
        err.message.should.match(/Invalid amount/);
      });
    });

    it('sendtoaddress success', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/tx/fee?numBlocks=2')
        .reply(200, {"feePerKb":20001,"numBlocks":2});

      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=112000000')
        .reply(200, {"unspents":[{"confirmations":228,"address":"2N2XYoQKXQGUXJUG7AvjA1LAGWzf65RcBHG","tx_hash":"ed426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae","tx_output_n":0,"value":10000000000,"script":"a91465cf7dc1dc237ad59225140773994a747674e42387","redeemScript":"5221021971b4d7c5d919e2655134ac12daa755cd1d6a14996c5b272de24178f3649e952103f8bb35d209e20c1f64f9f2c5686efbcb212a504d3c5ee65e9623187c03009a9321036d051911592ef2a7a72bd53c767d1e57f260c7627a8115d6204d9f33c7dbcc7b53ae","chainPath":"/0/27"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
        .reply(200, {"address":"2NAeb4PGKKBEFdUt2seThoomcR4YR5SpbuK","chain":1,"index":80,"path":"/1/80","redeemScript":"52210306d7f5f0c559ff585f215c54d769f3fa9460193e334d16c162b97d1d06c812f82103798fb98f249f00e93523cb6d60102ac9aed44288b1482b9d35b6d70d315ae4c621025d3bc26ba30510772f4404d00c5d907dbd17f7838a4facbf157e817fc6694f5053ae"});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/tx/send')
        .reply(200, {"transaction":"aaa","transactionHash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6"});

      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', 1.11, 'this one goes to eleven')
      .then(function(result) {
        result.should.equal('65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6');
      });
    });

    it('sendtoaddress success with instant', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?instant=true&target=113000000')
      .reply(200, {"unspents":[{"confirmations":228,"instant":true,"address":"2N2XYoQKXQGUXJUG7AvjA1LAGWzf65RcBHG","tx_hash":"ed426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae","tx_output_n":0,"value":10000000000,"script":"a91465cf7dc1dc237ad59225140773994a747674e42387","redeemScript":"5221021971b4d7c5d919e2655134ac12daa755cd1d6a14996c5b272de24178f3649e952103f8bb35d209e20c1f64f9f2c5686efbcb212a504d3c5ee65e9623187c03009a9321036d051911592ef2a7a72bd53c767d1e57f260c7627a8115d6204d9f33c7dbcc7b53ae","chainPath":"/0/27"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
      .reply(200, {"address":"2NAeb4PGKKBEFdUt2seThoomcR4YR5SpbuK","chain":1,"index":80,"path":"/1/80","redeemScript":"52210306d7f5f0c559ff585f215c54d769f3fa9460193e334d16c162b97d1d06c812f82103798fb98f249f00e93523cb6d60102ac9aed44288b1482b9d35b6d70d315ae4c621025d3bc26ba30510772f4404d00c5d907dbd17f7838a4facbf157e817fc6694f5053ae"});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/tx/send')
      .reply(200, {"transaction":"aaa","transactionHash":"88ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","instant":true,"instantId":"564ea1fa95f4344c6db00773d1277160"});

      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', 1.12, 'this one goes to eleven', '', true)
      .then(function(result) {
        result.should.equal('88ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6');
      });
    });
  });

  describe('Send many', function(done) {

    var recipients = {
      '2N4LzyvT64t9HXHaNXLVMugN4zyAfo9QQya': 1,
      '2N4kx6jh2zTtS681zaKA9t2Po91k2F84yfA': 2
    };

    var badAddrRecipients = {
      '2N4LzyvT64t9HXHaNXLVMugN4zyAfo9QQyA': 1,
      '2N4kx6jh2zTtS681zaKA9t2Po91k2F84yfA': 2
    };

    var badAmountRecipients = {
      '2N4LzyvT64t9HXHaNXLVMugN4zyAfo9QQya': -1,
      '2N4kx6jh2zTtS681zaKA9t2Po91k2F84yfA': 2
    };

    before(function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
        .persist()
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
        .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81873005758,"balance":81650985758,"pendingApprovals":[],"unconfirmedSends":null,"unconfirmedReceives":null});
    });

    it('sendmany no recipients', function() {
      return callRPC('sendmany', "", {})
      .then(expectError, function(err) {
        err.code.should.equal(-6);
        err.message.should.match(/Transaction amounts must be positive/);
      });
    });

    it('sendmany bad address', function() {
      return callRPC('sendmany', "", badAddrRecipients)
      .then(expectError, function(err) {
        err.code.should.equal(-5);
        err.message.should.match(/Invalid Bitcoin address/);
      });
    });

    it('sendmany no recipients', function() {
      return callRPC('sendmany', "", badAmountRecipients)
      .then(expectError, function(err) {
        err.code.should.equal(-3);
        err.message.should.match(/Invalid amount/);
      });
    });

    it('sendmany insufficient funds', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=301000000')
        .reply(200, {"unspents":[{"confirmations":1,"address":"2Mven9jcBoUHa1VQRZ9Jy8nffSqw8wKZQME","tx_hash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","tx_output_n":1,"value":9888990000,"script":"a914255ccaf2136ed07f8bf6377710c45bfc1e83ecdb87","redeemScript":"5221023386c28561433f727a66ecd952021717a657aa2676c3e9d0960b2cdebe9020822103aa1b8b73bcd211b8d007495da84deed00e41e27445af4beb5e0187a5b4665f71210251e6b6148fba4449d2c5825b338349afed6c7e05054caafc799888de879412ea53ae","chainPath":"/1/79"}],"pendingTransactions":false});

      return callRPC('sendmany', "", recipients, 3)
      .then(expectError, function(err) {
        err.code.should.equal(-6);
        err.message.should.match(/Insufficient funds/);
      });
    });

    it('sendmany success (recipients dictionary)', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=301000000')
        .reply(200, {"unspents":[{"confirmations":1,"address":"2Mven9jcBoUHa1VQRZ9Jy8nffSqw8wKZQME","tx_hash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","tx_output_n":1,"value":9888990000,"script":"a914255ccaf2136ed07f8bf6377710c45bfc1e83ecdb87","redeemScript":"5221023386c28561433f727a66ecd952021717a657aa2676c3e9d0960b2cdebe9020822103aa1b8b73bcd211b8d007495da84deed00e41e27445af4beb5e0187a5b4665f71210251e6b6148fba4449d2c5825b338349afed6c7e05054caafc799888de879412ea53ae","chainPath":"/1/79"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
        .reply(200, {"address":"2N5p9bXC4poJEb5jNcbu2BxuNeSn2qbEtpo","chain":1,"index":82,"path":"/1/82","redeemScript":"52210389f7e8e63adfcaa99b11523cbbd9df20ba6ff1a1ff8a2a68e27cb3e8bf21c5172103025ca7a7efedf5d3b544d7f87ee86cb0e1287dea9b5f2d98696d6c555a2dc8a021032d488227abffbd9a10a771bdc8ac469cc6f136a054b83dc826a3e252656cbc0653ae"});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/tx/send')
        .reply(200, {"transaction":"0000","transactionHash":"31b74078116169c64a304bbf593cbe68027ab12a8b274c53a5c367cda3f8898f"});

      return callRPC('sendmany', "", recipients)
      .then(function(result) {
        result.should.equal('31b74078116169c64a304bbf593cbe68027ab12a8b274c53a5c367cda3f8898f');
      });
    });

    it('sendmany success (recipients array)', function() {
      var recipientsArray = [
        { address: '2N4LzyvT64t9HXHaNXLVMugN4zyAfo9QQya', amount: 1},
        { address: '2N4kx6jh2zTtS681zaKA9t2Po91k2F84yfA', amount: 2}
      ];

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=301000000')
      .reply(200, {"unspents":[{"confirmations":1,"address":"2Mven9jcBoUHa1VQRZ9Jy8nffSqw8wKZQME","tx_hash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","tx_output_n":1,"value":9888990000,"script":"a914255ccaf2136ed07f8bf6377710c45bfc1e83ecdb87","redeemScript":"5221023386c28561433f727a66ecd952021717a657aa2676c3e9d0960b2cdebe9020822103aa1b8b73bcd211b8d007495da84deed00e41e27445af4beb5e0187a5b4665f71210251e6b6148fba4449d2c5825b338349afed6c7e05054caafc799888de879412ea53ae","chainPath":"/1/79"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
      .reply(200, {"address":"2N5p9bXC4poJEb5jNcbu2BxuNeSn2qbEtpo","chain":1,"index":82,"path":"/1/82","redeemScript":"52210389f7e8e63adfcaa99b11523cbbd9df20ba6ff1a1ff8a2a68e27cb3e8bf21c5172103025ca7a7efedf5d3b544d7f87ee86cb0e1287dea9b5f2d98696d6c555a2dc8a021032d488227abffbd9a10a771bdc8ac469cc6f136a054b83dc826a3e252656cbc0653ae"});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/tx/send')
      .reply(200, {"transaction":"0000","transactionHash":"31b74078116169c64a304bbf593cbe68027ab12a8b274c53a5c367cda3f8898f"});

      return callRPC('sendmany', "", recipientsArray)
      .then(function(result) {
        result.should.equal('31b74078116169c64a304bbf593cbe68027ab12a8b274c53a5c367cda3f8898f');
      });
    });

    it('sendmany success with instant', function() {
      var recipientsArray = [
        { address: '2N4LzyvT64t9HXHaNXLVMugN4zyAfo9QQya', amount: 3},
        { address: '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', amount: 5}
      ];

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?instant=true&target=801000000')
      .reply(200, {"unspents":[{"confirmations":1,"instant":true,"address":"2Mven9jcBoUHa1VQRZ9Jy8nffSqw8wKZQME","tx_hash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","tx_output_n":1,"value":9888990000,"script":"a914255ccaf2136ed07f8bf6377710c45bfc1e83ecdb87","redeemScript":"5221023386c28561433f727a66ecd952021717a657aa2676c3e9d0960b2cdebe9020822103aa1b8b73bcd211b8d007495da84deed00e41e27445af4beb5e0187a5b4665f71210251e6b6148fba4449d2c5825b338349afed6c7e05054caafc799888de879412ea53ae","chainPath":"/1/79"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
      .reply(200, {"address":"2N5p9bXC4poJEb5jNcbu2BxuNeSn2qbEtpo","chain":1,"index":82,"path":"/1/82","redeemScript":"52210389f7e8e63adfcaa99b11523cbbd9df20ba6ff1a1ff8a2a68e27cb3e8bf21c5172103025ca7a7efedf5d3b544d7f87ee86cb0e1287dea9b5f2d98696d6c555a2dc8a021032d488227abffbd9a10a771bdc8ac469cc6f136a054b83dc826a3e252656cbc0653ae"});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/tx/send')
      .reply(200, {"transaction":"0138","transactionHash":"1e1f5d1bb114554ef43ee67f593cbe68027ab12a8b274c53a5c367cda3f8898f","instant":true,"instantId":"562e2fa95f4344c6db00773d1277172"});
      return callRPC('sendmany', "", recipientsArray, 0, "", true)
      .then(function(result) {
        result.should.equal('1e1f5d1bb114554ef43ee67f593cbe68027ab12a8b274c53a5c367cda3f8898f');
      });
    });
  });

  describe('Set tx fee', function() {

    before(function() {
      nock.cleanAll();

      nock('https://test.bitgo.com:443')
      .persist()
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
      .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81873005758,"balance":81873005758,"pendingApprovals":[]});
    });

    it('getinfo', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/tx/fee?numBlocks=2')
      .reply(200, {"feePerKb":20000,"numBlocks":2});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, ["1f8b0800000000000203b5944b6f5c370c85ffcb5d4f6251122571b669da2c5c236d0ca34951041449cd4c33be36e6e1e681fcf7f016099014596453403b51d4393c9ff4613acfc77b9b4fc769fde787e9f4f6f5968fdb693d598cc014b96bea3997da2a62d02a2913e65e0be7d1330db40e81a0ab10132b77334d410da7d5d2ecee7cba3f9f5ecfd33aac26e59379e718001f85eaeb3a8675aa6b688f01c22b3fc1aa073b1e97a25f1ffebe7c6877efde1ee6977afdaabdbfbdedf0dbd3761e506e6e76792cf54739ecee4f5ece04399644620a39374d94ad42632d0341b3e45807582f25c6deaa9f7ce0fdd9c560c1bc58abd85653dfdfc99b67b6db6cbde523584dfff07e6f4bfb784537fc24bff8e9f7ababf9e9bbf24b7b7ff973dbcccf366f5e96cb1b7a7efcc37b1e4ccd6e5f7cd1843ec110911a77448ddd1219c43c4c02fabc0401838b4c2549950c80454a1d34c4f7b4b59ea8809af74849ba55cd3de1a8a58f5aabea924755200da563906452c2806459593144ea25f58294885c842fb3e433a0804cd653356ea1408d5a728a43ac8085612e25f64844b1148d7e3db43602e7141a2636f7285bdecdcff9b4207201171096a077c7275b9e373ecfd3e16c5e74378fdde1964fbbbbd9c30c1f575f9305c85828f84d68d84b00956c82c99d04f76c31d751a5328f9a64a86bebbdbb37e68cd5acfc285939ac437d8c94ff43d60f65f90d593d268f03559d30a21247979acbf057516b96282353298cfa35599008620d15fe27aeac8d11a30d0999b336f4e025b514b019fb1349a353eaa3e56ad9f188a23c1aa5486d40cf0269e12a5b47964e0a907217339208e06e63738fa5aa44c7314b6d5252904683b13707d7cd5b64f85707b289f66a9485a45a5001a792b9d784c19565f2af242e492a97e054230f446c42d511fc2e57e1227c43d57cdeefbf43d55fabc97f2eddcd9beb03cf4796cf3b83f747fbf809abd0fc1bda040000"],
      { 'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'});
      return callRPC('settxfee', 138)
      .then(function(result) {
        result.should.equal(true);
        return callRPC('getinfo');
      })
      .then(function(result) {
        result.bitgod.should.equal(true);
        result.version.should.equal(pjson.version);
        result.testnet.should.equal(true);
        result.token.should.equal(true);
        result.paytxfee.should.equal(138);
        result.txconfirmtarget.should.equal(-1);

        // previously unlocked for 300 seconds
        result.unlocked_until.should.be.greaterThan(Math.round(new Date().getTime() / 1000) - 10);
        result.unlocked_until.should.be.lessThan(Math.round(new Date().getTime() / 1000) + 300);
      });
    });

    it('send should fail with insufficient funds', function() {

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=211000000')
      .reply(200, {"unspents":[{"confirmations":228,"address":"2N2XYoQKXQGUXJUG7AvjA1LAGWzf65RcBHG","tx_hash":"ed426d37e56919485bec45c61043596781c09af0e9637998fcace7f59631c5ae","tx_output_n":0,"value":10000000000,"script":"a91465cf7dc1dc237ad59225140773994a747674e42387","redeemScript":"5221021971b4d7c5d919e2655134ac12daa755cd1d6a14996c5b272de24178f3649e952103f8bb35d209e20c1f64f9f2c5686efbcb212a504d3c5ee65e9623187c03009a9321036d051911592ef2a7a72bd53c767d1e57f260c7627a8115d6204d9f33c7dbcc7b53ae","chainPath":"/0/27"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1})
      .reply(200, {"address":"2NAeb4PGKKBEFdUt2seThoomcR4YR5SpbuK","chain":1,"index":80,"path":"/1/80","redeemScript":"52210306d7f5f0c559ff585f215c54d769f3fa9460193e334d16c162b97d1d06c812f82103798fb98f249f00e93523cb6d60102ac9aed44288b1482b9d35b6d70d315ae4c621025d3bc26ba30510772f4404d00c5d907dbd17f7838a4facbf157e817fc6694f5053ae"});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/tx/send')
      .reply(200, {"transaction":"aaa","transactionHash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6"});

      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', 1.11, 'this one goes to eleven')
      .then(expectError, function(err) {
        err.message.should.match(/fee rate too generous/);

        return callRPC('settxfee', 0.001);
      });
    });
  });

  describe('Set tx confirm target', function() {

    before(function () {
      nock.cleanAll();
    });

    it('getinfo', function () {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/tx/fee?numBlocks=4')
      .reply(200, {"feePerKb": 15608, "numBlocks": 4});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents')
      .reply(200, ["1f8b0800000000000203b5944b6f5c370c85ffcb5d4f6251122571b669da2c5c236d0ca34951041449cd4c33be36e6e1e681fcf7f016099014596453403b51d4393c9ff4613acfc77b9b4fc769fde787e9f4f6f5968fdb693d598cc014b96bea3997da2a62d02a2913e65e0be7d1330db40e81a0ab10132b77334d410da7d5d2ecee7cba3f9f5ecfd33aac26e59379e718001f85eaeb3a8675aa6b688f01c22b3fc1aa073b1e97a25f1ffebe7c6877efde1ee6977afdaabdbfbdedf0dbd3761e506e6e76792cf54739ecee4f5ece04399644620a39374d94ad42632d0341b3e45807582f25c6deaa9f7ce0fdd9c560c1bc58abd85653dfdfc99b67b6db6cbde523584dfff07e6f4bfb784537fc24bff8e9f7ababf9e9bbf24b7b7ff973dbcccf366f5e96cb1b7a7efcc37b1e4ccd6e5f7cd1843ec110911a77448ddd1219c43c4c02fabc0401838b4c2549950c80454a1d34c4f7b4b59ea8809af74849ba55cd3de1a8a58f5aabea924755200da563906452c2806459593144ea25f58294885c842fb3e433a0804cd653356ea1408d5a728a43ac8085612e25f64844b1148d7e3db43602e7141a2636f7285bdecdcff9b4207201171096a077c7275b9e373ecfd3e16c5e74378fdde1964fbbbbd9c30c1f575f9305c85828f84d68d84b00956c82c99d04f76c31d751a5328f9a64a86bebbdbb37e68cd5acfc285939ac437d8c94ff43d60f65f90d593d268f03559d30a21247979acbf057516b96282353298cfa35599008620d15fe27aeac8d11a30d0999b336f4e025b514b019fb1349a353eaa3e56ad9f188a23c1aa5486d40cf0269e12a5b47964e0a907217339208e06e63738fa5aa44c7314b6d5252904683b13707d7cd5b64f85707b289f66a9485a45a5001a792b9d784c19565f2af242e492a97e054230f446c42d511fc2e57e1227c43d57cdeefbf43d55fabc97f2eddcd9beb03cf4796cf3b83f747fbf809abd0fc1bda040000"],
      {
        'content-encoding': 'gzip',
        'content-type': 'application/json; charset=utf-8',
        vary: 'Accept-Encoding',
        'transfer-encoding': 'chunked'
      });

      return callRPC('settxconfirmtarget', 4)
      .then(function (result) {
        result.should.equal(true);
        return callRPC('getinfo');
      })
      .then(function (result) {
        result.bitgod.should.equal(true);
        result.version.should.equal(pjson.version);
        result.testnet.should.equal(true);
        result.token.should.equal(true);
        result.paytxfee.should.equal(0.00015608);
        result.txconfirmtarget.should.equal(4);
      });
    });
  });

  describe('Freeze wallet', function(done) {

    before(function() {
      nock.cleanAll();
    });

    it('freezewallet invalid duration', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/freeze', {"duration":-10})
        .reply(400, {"error":"invalid duration"});

      return callRPC('freezewallet', -10)
      .then(expectError, function(err) {
        err.message.should.match(/invalid duration/);
      });
    });

    it('freezewallet', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/freeze', {"duration":10})
        .reply(200, {"time":"2015-01-30T20:16:20.233Z","expires":"2015-01-30T20:16:30.233Z"});

      return callRPC('freezewallet', 10)
      .then(function(result) {
        result.time.should.equal('2015-01-30T20:16:20.233Z');
        result.expires.should.equal('2015-01-30T20:16:30.233Z');
      });
    });

    it('send fails after freezewallet', function() {

      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
        .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-30T20:22:15.961Z","expires":"2015-01-30T20:22:25.961Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81350975758,"balance":80708955758,"pendingApprovals":[],"unconfirmedReceives":null,"unconfirmedSends":null});


      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=101000000')
        .reply(200, {"unspents":[{"confirmations":0,"address":"2NEgkNLZcU9c9usDFTZ5c4YffCWA7gR3GMQ","tx_hash":"83b4d9cc64eb494659daa4fe244f3152d05100629793a4ff5fbb71a5bce110a4","tx_output_n":1,"value":71440985758,"script":"a914eb2e66914b73199857f669ba96d2f105d59f4b2387","redeemScript":"5221030f9653fee93fc9cd9f01d0e5af17d0c5dcc02babae2abc605eb64fc69ecdb2482102a2cf52c0addb5ae6587ddf275c6b32dac6265f66616a0fb00ff23ea4b11b681a21032b6f31e70d87fdba586e149bc6d78dde8814e529259a4a85314335d54c8dd5e453ae","chainPath":"/1/84"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
        .reply(200, {"address":"2N4Jxq3Z4GJoPucrgghFm75R8bLv8q1GTD3","chain":1,"index":86,"path":"/1/86","redeemScript":"5221025f9015b8ab25457a36cda1cfeef40af9210ebfc0ac9ee014e38a72100df1f4dc210367718564ea653156e5711ccb6d438d4e571dc35fb25990cb88bc894af96682122102c796b0baf1b5d11c3a2cbeed01158dd3aec81ea33c213555c94c24ce39fcf14453ae"});

      nock('https://test.bitgo.com:443')
        .post('/api/v1/tx/send')
        .reply(403, {"error":"wallet is frozen, cannot spend"});

      return callRPC('sendmany', "", {'2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG': 1}, 0, 'frozen')
      .then(expectError, function(err) {
        err.message.should.match(/wallet is frozen, cannot spend/);
      });
    });
  });


  describe('Lock wallet', function(done) {

    before(function() {
      nock.cleanAll();
    });

    it('walletlock', function() {
      return callRPC('walletlock')
      .then(function(result) {
        assert(result === null);
      });
    });

    it('cannot send after walletlock', function() {
      nock('https://test.bitgo.com:443')
      .get('/api/v1/tx/fee?numBlocks=4')
      .reply(200, {"feePerKb": 20000, "numBlocks": 2});

      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX')
        .reply(200, {"id":"2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX","label":"Test Wallet 1","isActive":true,"type":"safehd","freeze":{"time":"2015-01-19T19:42:04.212Z","expires":"2015-01-19T19:42:14.212Z"},"adminCount":1,"private":{"keychains":[{"xpub":"xpub661MyMwAqRbcEfREDmUVK3o5wekgo2kMd8P7tZK8zrDgB454cuVJsUN5XzzwmdFRwjooWmmj6oovEZLoa66iHMBqv9JurunU6qKuCvcpMDh","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcFSu5cKZMN8LdcTZ14ADiopVd6SpgCLhpENP2VXLZLcarfN1qwJYx8yuyp6QkmFWaYLk4LLDR5DMTWEMKb69UzhKXcxPP2XG","path":"/0/0"},{"xpub":"xpub661MyMwAqRbcGeVsWGCm1sagwUJS7AKJjW1GztdKx4wp1UP9xpNs5PKPqVF6xaX9jQX3Z2i6dT5oJycFEdthymPViwRAmrFggvASmbjWaeu","path":"/0/0"}]},"permissions":"admin,spend,view","admin":{},"spendingAccount":true,"confirmedBalance":81650985758,"balance":81350975758,"pendingApprovals":[],"unconfirmedReceives":null,"unconfirmedSends":null});

      nock('https://test.bitgo.com:443')
      .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/unspents?target=315000000')
      .reply(200, {"unspents":[{"confirmations":1,"address":"2Mven9jcBoUHa1VQRZ9Jy8nffSqw8wKZQME","tx_hash":"65ab38cd15e980ac2e4337f08b84fb53fcd71e1f5d1bb114554ef43ee67617a6","tx_output_n":1,"value":9888990000,"script":"a914255ccaf2136ed07f8bf6377710c45bfc1e83ecdb87","redeemScript":"5221023386c28561433f727a66ecd952021717a657aa2676c3e9d0960b2cdebe9020822103aa1b8b73bcd211b8d007495da84deed00e41e27445af4beb5e0187a5b4665f71210251e6b6148fba4449d2c5825b338349afed6c7e05054caafc799888de879412ea53ae","chainPath":"/1/79"}],"pendingTransactions":false});

      nock('https://test.bitgo.com:443')
      .post('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/address/1', {"chain":1, "validate":true})
      .reply(200, {"address":"2N4Jxq3Z4GJoPucrgghFm75R8bLv8q1GTD3","chain":1,"index":86,"path":"/1/86","redeemScript":"5221025f9015b8ab25457a36cda1cfeef40af9210ebfc0ac9ee014e38a72100df1f4dc210367718564ea653156e5711ccb6d438d4e571dc35fb25990cb88bc894af96682122102c796b0baf1b5d11c3a2cbeed01158dd3aec81ea33c213555c94c24ce39fcf14453ae"});

      return callRPC('sendtoaddress', '2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG', 3.14, 'have some pi')
      .then(expectError, function(err) {
        err.code.should.equal(-13);
        err.message.should.match(/Please use walletpassphrase or setkeychain first/);
      });
    });

    it('lock', function() {
      nock('https://test.bitgo.com:443')
        .post('/api/v1/user/lock')
        .reply(200, {"session":{"client":"bitgo","user":"5461addd9b904dac1200003353061409","scope":["user_manage","openid","profile","wallet_create","wallet_manage_all","wallet_approve_all","wallet_spend_all","wallet_edit_all","wallet_view_all"],"expires":"2015-01-30T20:39:06.859Z","origin":"test.bitgo.com"}});
      return callRPC('lock')
      .then(function(result) {
        result.should.equal('Locked');
      });
    });
  });

  describe('Get Wallet Addresses', function() {

    before(function() {
      nock.cleanAll();
    });

    it('getaddressesbyaccount with no paging', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/addresses')
        .reply(200, {"addresses":[{"chain":0,"index":0,"path":"/0/0","address":"2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr9"},{"chain":0,"index":1,"path":"/0/1","address":"2NAvfxq4AmDE89eJbAjNK2gXu1kfFNu99Bo"}],"start":0,"count":2,"total":2,"hasMore":false});
      return callRPC('getaddressesbyaccount')
      .then(function(result) {
        result[0].should.eql('2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr9');
        result[1].should.eql('2NAvfxq4AmDE89eJbAjNK2gXu1kfFNu99Bo');
      });
    });

    it('getaddressesbyaccount with paging', function() {
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/addresses')
        .reply(200, {"addresses": createUniqueFakeAddressList(500),"start":0,"count":500,"total":502,"hasMore":true});
      nock('https://test.bitgo.com:443')
        .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/addresses?skip=500')
        .reply(200, {"addresses":[{"chain":0,"index":0,"path":"/0/0","address":"2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr8"}, {"chain":0,"index":1,"path":"/0/1","address":"2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr9"}],"start":501,"count":2,"total":502,"hasMore":false});
      return callRPC('getaddressesbyaccount')
      .then(function(result) {
        result.length.should.equal(502);
      });
    });
  });

  describe('Help Call', function() {
    it('help', function() {
      return callRPC('help')
      .then(function(result) {
        _.forEach(bitgod.traditionalBitcoindMethods, function(value, key) {
          _.contains(result['Traditional bitcoind calls'], key).should.eql(true);
        });

        _.forEach(bitgod.traditionalBitcoindMethods, function(value, key) {
          _.contains(result['Calls specific to BitGo'], key).should.eql(false);
        });

        _.forEach(bitgod.bitgoSpecificMethods, function(value, key) {
          _.contains(result['Calls specific to BitGo'], key).should.eql(true);
        });

        _.forEach(bitgod.bitgoSpecificMethods, function(value, key) {
          _.contains(result['Traditional bitcoind calls'], key).should.eql(false);
        });
      });
    });
  });


  describe('Received by address', function(done) {

    before(function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
          .persist()
          .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500')
          .reply(200, ["1f8b0800000000000203ed9d697762c7b2a6ff4b7db67be53ce81b33cdb4408004f4ea0f3902e2308819ee3affbd23e5630bc9a80ab0745dee755d76b94a25edd2de3cbcf1464664e47f7d5b2fcd6c65dc7a3c9fadbeddfd9ffffa36f6dfeebe7912a5b55c30144374dc581e893491324584a356322928755479a12842d831492c268206ec358e527dfbe59b37eb00572208f35f11f915890ec17748de71f4bf104203f88c18e01330fc06fdf26dbe592f36ebdfbe832dfce6db1d7cd03837dfccd6e92a0d8d7bc7eebeb66c4f62be6eeeddae350a3a6f36a3417dd49def4b4bb8e0d6fc6bf3fb257ffbe7dfbffc7e39fce672f57dec338e1783fe484daa857ac9c68748779967c268d8b9fa43ebf5724208ae94e692ab5fbe8d57f5f10c3eb85e6ec22fdfdcc88c672fd77ef9d5ff9ef9b0ff76a7f9bfffef2fdfc26cbd1c87dfeee8cd8d3c981c6be7ef1b8d59e1204aea582baae1ac3c9cf445ed413757bdd7bff9d7dfee04ff7e279ff03ce01b73f3591c2fa7e63f2fb92498b25fbe2dc2cc8f67c36f77d1fc6b05b766ff35779391598de06ffbfdab8dd24e11153856812286b58a4a591d6d348822813477c651665c50dca5cfe2400c331cbe9551180f47f09d5342b054e9665e3803a82c6528d01810b1c42327acc7420b8cb4e2de111998c28e0acf74c0d163838917d4c333b1f04bfcf99c65a6d5ea94f426c762a3b0b4b8be8b2b9ed9ae577c942bb9fbee7e7c15678d4ca385b78545b34cf0d4dd875e2b5f6b3e148f6260f866f6240a0faf97e32f9ca92b3893ff0d9cddf83c7e32cea896ca198eb0c09170e534c61a444c7a45103714644c32eba38f8a6989390345d31e2b6b04275a1a7f9e3374c7e41dd3b77056df648fc5417f723898ecfc781c11c36335b3d8b58ebbdaa133aa6ec5b9e7fa216642b8f01c426bdabbf7033153d92675f55e76d468d856e6913756af5753f06034ffedbbbc8832f2a9949d83ecc687719e317e19639e82a068c7b0d11cb8408e09eca236c604ce9de7d444129d205e618d8d62123e87624ede33265fb54c236a191005d7d5581b8d18475c732d50608459eabd032d231c734c559098d2e88912247a1ab8a59fcfd87a9079ae3cd6b2b9e9faa9df928f71ed7a7d50d1fa5361abb685fbc1558c65e6d3075163c7716d1f7b4fbdf6a4e466b36967f6bcae57fba5f1289e844ccd18d2e20a29c35f0fd96d4fe327830c1e2b5c298674498481066641a5ac3752e174adc849b4c8c165b40311e5464909af84942e805da3e2d3216b14981db4c7ebee7e7e5f2b0e59573c97274fcb5cefb191d9b6b2f939bf0a325d696632b5d96ad35e9526931dbf9fc7c75cefb9b87b782c05d71ced4f2053ece5695c0e19fd1e6437dfc72790fa9341164d14467a6621cc72d02bc705c55159cba40d116b8684608a394a30435cd8a0204446891c2206336ccf40463b88dd617187d94d90e5b2eb3d5d8d16b879a0cb798f854eaf87fd40066be678517e3ab5513f424c351fe661e6448e97da3bdec9ef4a4af63b0f95d62e2adc63f4c439eb142bc515b1127d8fb01b6fe256bef8f7e8621a5d46577aed8da0ce48298d66117c11d8076e24d3514683b98c982ba2c136214a228d9673821d7e43175684fc4117d6440bc2a214c1222b540075f218aea2b5560a430ec93166f0075445123c02f30737c222d714fe409ff362b883f05d52317a135d74221fdbddc5341e7067b87d2a8f372d915f65f4be5d1c75b3b5fd555eacbedbcaf85c50ed7e9f1cf3448cb753fac8c9a155af156a7ad2a2277152a22461f2720953facbe3e48d4fe30c6494087c1964e0b4690822444139b87fa414531419268024c8f92867c6322ab86751600fa91f7c2448f6d6f063c4f11f90a964c5b4738205cb34135c7b63580c84b198c4cfc3272324c0dc6b0a1f8f3c5a2bb1e1d6058ce16f7e0f19fe95a20e217714dfd11b216bcfb15de9b8a9850cad2f57d952733a31fd7aaff4d89ae1f263e9f5b1a67bf9be86158693466de0ba10e437ab7cb133e08ef563cc3d66e4f09e96ea27cb171227c6ae482b15fb2cc6d27d9c47ec9667718e30852e4d29c123598d29e15c191422f32e7ac90138e911300539a4b0364642e04f21a60aee2cb082de1086387a4d292563040704bc10a2a3d39178169c84d492c2850d089c929a28195d40cac908264c41540682233027cdcf4d587db38c36a7d9633733191c375b512293fb21cd759f2be586dcb275ef344a0aa9e5e55152f1ff01ec02c028b69221f0f55860a141c90c450c2e0171d0d920144a8b6798186589640e6c1e775448e70d8d4a69153f020c0360e426c058ed78d876045beb72af6c1abdda437d336cb0e32113e7bad53a983391e143096393bd781a916367dd160a1f4d35a3d7a439d778428a8a1d62e6f562e4cf17236f2fc617daf6726c31af142c7f6a38bb21d9fda611da33f26c0bebc5fc84d6b498abaea0f5d3d63fe84711f7d647f1975f9bf3c45f9877109bb284c89471802a0a5268ed38406da48b107d31525aca1001764b21c2522791922cbe27fe35ef486f14c820e0c5d1de9a80b00c2470afe12dc3b174d651ce39e3c92006a288e33c80d2464bc051420ac4cf138fef38108fbf5a5231fe51d0ce80156996aad56ca1e8bb6bb20a9dd17c3e75f7ac7fcfdb0bbba99e066d29b0bea2e6a0d0a71943fcd735f5f5599c274c5c4618478e326a8c4012a72561892055888e40d495c1fba8444cc8d1c89908cac1673b10de97d5da3784893f0813dc58aac053f2001a60e0528c521991b28a41e642a3f312071cb9c7d6421602b8c115933785d7431af1731356df86997e72d979b76cf043eb7ea02b07358bb1fdbc53bbeaa0552f9cc8a00219d497cba0d4ff03d8058005cf88f054062e34d64c711b1ce34e40024b79b280d8216d220a1a8c01e4bbd1191724c47441b1e3269c050ca93b4eeff86d4b27a4d79fb7aabd56a9dbab744b32b37dcae05aa6f4788c82dfbb6cb974b680f30114e82d14447ebcca92adcc7bb3c55a670fc7bddd0ffa3c34978b15dedaf6b45612757d2a764a426cbc5cece4e79624ce31c4d0a5c52a1ce15524543a61930913d8387064cc722cc091294169b0100a0578e44880052b884210ccde32444e8a551aec9c0acc30c67cb002a58a8d55409555010788addcf1e8a9897015c385e714fb80e07f9c690752f6678688ee10fac2d04dc6afbe2b3d764a83192f94f3abc1bc5fca129bcff99c65bbdac32a3f50856b8c5fae7fac168f6cd3dad61e3255aef7b9facc2c3bf9ae29986391b6d949adea850c7c3919e2534ba267cb08373d8bb384697de102af07ed8067c0853310b340ac18c814b121f868ad8e284529a968002082f2c64a9e7207f28e304c5fc3a091146094269540adf024d5442368166138680612a5bc30082ecf904bb90d38afe03128a251cc90709e307447d3bf7f3f6105fd342cf2cebc2576192c1f3aeaf0b0a83c6ffd6c537fa86e0f557b4a9806c2c81584897f0e6160602e232c68eb4c101c625dd49e6b0b1926365ed168b491447301626324e2d1596a3065914160d4ef9257ac4f1a3b2812dea54018a8739c1109aa45b95729c846efe08b638000e8107c0a2560b6b8a152452aa2b7f0a96708a31d0c7871f05a37c5c1fc02cb3acb2f5ceccae1eefe49ed478be752b35596fb878715cfe4ae5ae43df696c5495caa5973b45d5740879ff9310ef7c387657f979f8df3f9d3823b07c4d81588b1af5fe4bded699c812c55192eac24500f0838888990b959101e02999c4528e2a062f0d6f364b818925e126282f4c1610471ed1432ac297e5de475491ba5b106bc96a242689e4a118032a7d458f870202852464039697060c20c2700309830c80228139f0f191653b1ab93dc7852bff759d7a9f5e27058211dc3ecb6ef36a5e29f4b3c1fcb989cd79f1622877da9c68ae5052fad483fb0fda4b6c6996eb9b53f9e328680317a05639fb606c73f42eca667f1b311162827e98a204b4ec8b48ac1284ea4b140a53552394720d41a8d030b1c41a648828854518d3448da59c210bda3e28ef3af0e943fac84f2ed51ef8ebbce72b88fdd9eaa093cdcedcd68566eec1e74eba970da35443148fa155504413f11b0bf1a26f977f1a217e2152d812c1052bbc0553404be17ed09f87af0e84a0416e1cfd3926d745e017ae0cb0d43168bf8162fa25ef1d2211204092303e366e173835331595e502f263cc68e5264210d00dc7404e00c0468ae039608525c8fcef93092040cb13b7a5bb608df75bbbfdde07d2bb45bb3c5803d341e06a2e3eefbee793277667e055e42d49f32711d1f8f76dede6597a34af9d03c2e17db512fbb76b578d27003b7784d05417c3701bcf11ebea2cece312297c1a5236404808fb25881838f9a71072f3b33818233c360c49c249e1382490a7b0818108804fd0e2e8c5eeb07cc6b481ab085fc4144f07548336035029b9679ab83e3828392111a987252a6dc119900b90342d2ea33da8545aa1f707447d0577771fcd0e4d7376ed0ca2ddbaccd57f9fdf4a9e59b3db72e179a612dfc782856f76fc40ba2e315aba9027f521f07feac46a18f0913eac24e0eca4570de59e23d258e6a152386b4522b2230e1e0ea43404168efbda1","1e4b1949c45845f9863025e86b2787a03840e813d645acb197162222718483ec819197d4400a6914890089d134f10cfe2b80e5b7ca5b43f179c2f01d527784ff0469e42cb64ca3d46ad9fe5475e934ac69bb5c8cb8726cb9ecb0414e0c0c4bbd2b97eb17d7ff98241214e24205c360801478254f1017227211b5955e5866b9864ccf6227437a4c5e19ef280245a38480e6bde38b9c2818980e4e0c88a84669a103042d84b48eea9903f746b96218886224ad830067dc580dd2e6784056454dcff285f01d26b72d844d97dbd63d61f35028e3e373a3170af7858eb8aff9b869b63bb21faad744c7fcd11debc5876e2b6b494b72f650d39dcc70b2ad30793feadf6f4ef58b4850e5cbf58babaf355f373d8873704975e10ac5cb3fcc0aab52859d382da2724a05e10d365a1b2001439a6d254a6bacdc04941a2ecc3bb838795da17052a3c884b45468055112940d058219e4869611e79883286b050227af3852a0691028816f1f8262ce9c2936629ec48ba13b266e806b86bbeb163e84f18ecb81dd0f2bdbd9ac2ae71d12869b7bfed49d35ae5a6475d37c93cdf551cfee67a3a61cb47ccd356d2bf7d0dae6797679e2bd52dfdd158520cebe58bb6e7b10e7e852979aafdfe8022131d630ee415f04a489c43a84d54be345d2aa881816c412704a1abb007eec5d68e427e68b1948110c843c14c172511ad28a1a443e160d63523247a2a5d1638a7d6a394bbdb63868e11537f03efff38613a08b26f3c5e86d744d8fb3d1c1fb4a876462a9cc26199f593d667ba4385e9352c68c279bab7a3728c995d68b47160e193991bbd270395af6f6bcaaf6c736cde6caa7da4509c5572ce173fac57cddf628cef025905257f08595027a9c5401234c5f7631f9e8289828d02be0450722012c6b25d1928093626f17261444cb3ff8b269b91f3ba384c64884289547e0e581596340bd2c862fa7969997ae6d0e6aa65ca05e3125304028f079be2073a47758bde18b5eba41f3f257465e5765fc4e4745aeb17d62f461db7814f5e3b0d3ce33de9a4ec6eb6ad3af6db17fb2d0cf507aacbfbf949f60ed7f85b731fdcbe65e7e9420dc7c6b7fa2f4e22a8066d45b9e04c801a15a33c2715a36855088ad8846eae88dc7c478eb2da48bca612c3c316f293dad0280df733202f7a9e38a5283a8a4d442d2e0954d8b279a2088a904b4170415e2b892d6427eab0464c106737a9652307054ddb87c76cd0bccc88f7530ec47c761cecdfab9c6fe8873ed696627456d2bcae5e95c6dbb8fa73ac848b2b397eb20f9245019f98c24f4e52a1f66a1825c5a2e0f087b2220674c48a5bd9b2064287a145c48a68b47194c0c4a24b5a290b243d6a0ecbb723956e8740f315c4304ee10414c4b8e8d836c13223849898250a08f364032a0bc361c4854e01d533ba685af81f4349ce99344ba83c0c5913b226f6bb9c0d9351f3cb5863c3c566aa5cd70d827f938291ff6a366d59861f68a2a40fd807bcbb91f572a3494ab935cb17f7cb04d9ded957d93762a3b5a39610c8c2a2557ac73b0efe6a1b7dec65faf249c234ce90b9b7ab432322d9522e25d6434951589562c38031a8921f2c6088203d7d3902f00252a7d9ea56fcae55882d77b6df5f638c0858533c28454a19490eb5348415dda88903203275261dcf3480564a3c16a2691b64034a7e0033f9f30dc5cd79bb8b86d56f63d35ee6ed676b2bf7fb8cf29b177fb5014a36b08dbdebbe6743278ea916cae2a89ef148e74f78c4d8b1e9bd2f543e394300c2a76452d93a3afaf33ddf22c7e32c298b60e540e2224174ac8089947a0282dc61961a9d6012225f3524ac72c8b0ee44fc0e73ad041261517eef3092be430d5e30add75eaa19d63a5f9aa5ae84f17d3d21cccc6245b6c5c53c92c340f92647c6d32ecb87dbf549890dcb25f1ee44ac5ce72bfec0f272784a55882afa864f2efaed5de7a1bffdf69184447637c4c1d3fca43b484c4c0a51d9b02be1ac1c7b9d2101883b34c4478f8103ec1de11903d482e140eea0c61eaa51a20efd04db5f2fa1e7797fd9dea151e0b4aee66abb8af2ffb313c3eadb28bc75ca6d3b9a61ab0ad970a85637637d9769fb7a3eabe6a9f5875d25a9427f76ebb5ffa934d9de045afd8d2c9d4972fd5def420cee1a5d135f928d186588e92e396d86a01a61b08c5f06a4b2e42da4da2b892d410e4ac40926a87dee1855ef3d1183c8204961ba122b0c8a37082a160c0d92b06bce9804cb0d4a4ee34c748a2cf4a0f7ecd1a0ef9063b8b17d67784dda1b7f9a8d6847c6e3a8a3f291bcd950ea3a7de66c0f6b3318ffde106b7769351abcff6f9ceb651e367b6715cd8664b3fd8f8327dc6854e4b54059b4c3afe90e5dd88d5fd70e30a9391c00c24e1e42ec5cb329ffc2c9ee959b59c3e0dc8bebfac39590ddb56e837a68f5d5ed387a7be586db2edfcc09fbc233e484c6ebeab3fbf21d8857b5958a4117b2b98e198091f9123361ae2057e599d231863af59f0412a27a8705c328d257e9b95482a5ef7b2485053e605e2c109a42343262dc328b0865c838a6be9d25b00121fc88314fcf59e6304e989d398456fe9876f08046f885b22fa352fcc8f13df3cdd94cadd36159d633b5f99324bcbddcaa058ecf632d5c372bfdf9eca2d78657a45f1827d5a0f2ff96001f0a647719eaf0be339c691a8b4f0a190331ee00a8e78e51872de69ab88e416a9a03ce790433890381563c42f14bce14b9c4c34d290d36209497364029934e941720e0930002a0de1002da269c73ef0e3244e95b3347206ccbba5eec5299ce14bdd31e0ebed02333c02293f5771c9a728ee743c5ef69bf35533d7cf769ab3e2beef5d65ba2baff4dadf2fabf3c1496aac5309927cd6d23239af5b377c3fef846f0321b13fc9776acfea382c98f553d957969beae30a881b65e8d3bbdd84df01535e06669af26128369431674004d3dc2ba58123e210159c45e38cb101d21017bd0a310dc41204fd49f8f86b2a436de060337d5020a34e29f00210e553a31d89f07f6aace00a739566d8c025bd36da47012e803b4923bb1c4c8a39d33f16be4523f66b71f3244ca3bc2b503d69b7787f78983ffaccb1b9e84dc3e95299a2f4e3d93457580af25b49ed62c23f87cb3ffeda775cddf2084e0b26fdee44b74bb9e3a6b8d40b21179b90d7fbb8e81f1ae12088386916fe155212cd18d7b7bf357efdebef0d7cfefdb92b94c2533b50ac6879b4ce2ffb9cf24ca7540ff3639c1fdb9bce8f2f316dd48ac55a755dcff6d8b016d68bee521c0795696d3ecd364aebb23877899fec1d0a69a5509c616e200279c4e07d19297c05c784eab47529cd5aa4c238458d4ae5038dc0a8308205e718dec567dfa188a7a18b37751d4eb74fdde15e8d733bfdb418648ea5c6a6fc18716fcb5b9bfea1ae1f27d7d426f1f3cab6f8b2c3d706ef8ec755fbe9b07cd8d5db6237accd2ab8d33eb1b057351db2afdef971db7338039704302edcc32d8c0657412485b7824b3b1c954ecdd2d15087c0a818812276e0b1d3cf0a1127ac65ea5dc7b424529c744c63e5bda412dec11e499bc2548c166b44d25a95a0360aa037f5ed7bb0c6243805baaf230ff4a5f9f03c5c2f133db1feea9e30c27e3ca04c94470b90c167b96af15da6dd9d0d72cd3ae507d7ef0f43e5f9b4f49dca5bf48ad237fdb4d68a971bf9ab7d61274fe32c64e2c2d506e5a5b6902e099926057382b9908683a409c204f68a31c87b10f73499626006396a91d7f11d64ec75b5213550a4fe8954244796a6c91bc183305a903e6153fb35a0c54914960153401e92409a0f11c4ce6a747e310bbd4cc17b57fdfe0ac82ed8f9b126054bf4a47f6c4fc739465663daeee67d27cedb8d7bb3793ad1308d054076455d917c5aef21e19f0119ff0164176e9284e0873c4a49930e11a7111f0005244292198d71c0a9d42888f2f0864c7bce14559c0be4f97bc85e374946ab15a4ff69ee30d290ebc710097c154e13aa2c314ab9a0694805379ad60802960a6e4606e42012072c3e822c2999f86ac87e2ffa7e678fe4aacb8bcb67a7f17d7ebe704cec773917a4c8970f9971de9c6c0b67570d0a209f96bec33dfc55bafe780c67d992176efc8014c52a8331e111c3fb2c182fb0708406e93d61f006d42e2d10819c999846091062592a03be67eb75e307e7f0f60632a96656a43630088c90fc6811914fdb4a50f052407ae4b9471aa7c965d2409acf29522c6a64fe56b67ebc1a7f28b2e266532c89d56376fdd42c64439d079729f47a83d5dae6e6c313fd4257c1f5cfd97dfb77e2e5ad75408fe63480d7175e440a69b9001fa6d274ebb432c9d2f637c6013c03060cbe380641b0076174ec5c0efe3225364d59247ff700cffab143dd5cb007bc6b579e9bbba7deb8b79f76779d5e66d83354154e6cb26618a2e315d5c4ef2f11fd44133cc1745fdadcaa8d0367154cd03e520c2fbda504dc36553878ac9cf30e49c6436a6d504800648143baf7b6ad4b82733aa95683a743c6816563283af07704aead038444fa325e51835ca168c09a01d59448ed38fc3619c0b485fc3c5e49bac87b8f7fd924f5feb846bab5c72dc199f6ae3aac3d87c3531fb2d83eab48bdcb9d9aa56bd61df1870b8fc7f17c51ad361e2a621a76cfc57a75d3edf9e85de39e2f4bdddaa47daa110a73fafdbec31baf773b591a9f5ddc58b56b8d28564c13d5ee3e3764f5491ef3e5f1a2651e5ab3ccb8327f33c54792d7fbfa139df4d2d19f3402e50a6cbc709483ab029e2c84bfe82302a1421c525299a6a044876ddacecbbd8a903eb83774a69ddfaf74a6fd255184d46898f66c3aadbdc4ce788529811cd73a82a4e45606210c0b8684800ca1827303a9098ee7e9147794bc8fad97085fb1948dc68987ccaef7909d6caa073d6850b96c55ee3bdb07b2e96f4ee7285e43a7fe00ce19e9d1c7566bb8dccaf848b3cdd2beb892319f19f437f9fb5133f77432425bcbdf762da1cf5a80d4e41c58377e4bef16ef1a8cd7069d2da6b54ed6db0753cdbadeea7e559fe5abfdd276543f5d4154fa7b91995e9a5420e2a81014a8e42aed0b90c1380c06cc47e22c689c03cfcfa8c136a4cc43882819fc44f43b384f920a2b44e03c401a0257603ad5c185c3319db1032198c900c1991001026a9502a9b40672dae03836d804c43e809325e944fa4be1d49f01e774bf6e10d27958dedf57b6629aa57c2859c747953d3e3e37f272527bb32718fdc6d367c1a9cfc3b91b0cb2935da55dcb56aa23ddf058d0dabab8282cf6a5eebeda3d9ea6241c72217286ce9befebcf704a71e97674659174106db10ac2b808e1d673eb19f095762c79ab344005a11e4b08d5001dd046157907277d5dbb234824cde4082432a6c5612495f5ca1bcd03047aa422a30c7eadb18518843501ef685d080c0c6b2a6c9e8113bfc0c9c057dd36b465a78aec50a96756ddf58e2dfc708047b5fe6170249ddc4e67dbf92b32de5ca1b63834db60189bcdfb956e06450a99ce7494b9dfd1756487dc1bdb08def98aa30508fee2a4f7a62771062f852fae3b004a5a2b26c13152067ca523091064a4a9e44035bceecaca347f364dd210017e48f026feedaa1d2432af75070e1ac61cf817aac0240646ac93da4a873c49dbdb3904f1b44d3428903b2118a43ad2a66ec008a64028a33e1faf9cd9914eb7fdec59bb5818962ab5a5e8d61dddefa40e839dce8d2fc7abbe5f97167e3b6fb572b96968e5f9a4b66a568a956d57d5f6a321f64f6ff0","e2945ed1454bbebf17e0b6bbf8cb84fe6478a5017bdc7ba79d964e2b6e15b25a0ab083c460c856343602f043a91f07a7598c4410a5200c7b47b412fe3c5e69eee2ad49ef670ed3c8d87576d02935f3f3fcd3a4b9e77d3e7abc8fddc1f8b9bf9997f0e08d7a119a0a7e97e385fe21e334002f75e989024c3985a31521a8344857480a91ca046e82a2a96ca089b5297cf1188d85a0ce38c658bfc7ebb5e6a04d340cae648132c498f0043303193038390034822dc4e9ac4465a24f0761c0672b030073252d87bfe32d5eec574c7ea5b8936671f33b267f82711af7035773cbae9ff6d6dd901d66d7da0ecb22b20c2e3fd2ca3efb862f0536e572beb0fec78cd350845e384e43529dcec734d4206465eac9d6dc594920d55402074cbd63ced8d40f412c75d1425c4b65fab78441eafb2a609016686007120203de1f14306809a205c297a671f8a08cd03a0845244dfdde60cc587090330b26a354fc2c6148dd617e47c5df3e6c2ab3c9b28735ed8e3b6cf3d038749afb7bc5bb9998d734379fe417d553c0280076c5b029acfe21c3a6146197a69e2c201992abb6d8b1c07504cfe083730843e8c21ae3889d8f51788fa3f412328aa80879e7ee91784d3d9176023b143810644048c1c85b483791b3169eb68064d3484e21f12494a5162d0f1f25c6114421b7a0f2bc80a5765472c76fb35f57ccbdc73fc2abd46be1e146b5e8331d0ed578f4acfbade553b55278a875dba5c5833fc58b6bc4ae2899e2cf1c79f0574f00c0dfc54b5c68bf4cdae28b68c41020754c561c38e3c212eeb850321d8d435e1a3402161e6228265844cac53bbcd8abfdb21c32cf34f9d80796940fa4cf2191ce8a8a3242d0240c6082c049c0e51319354addd6a0694e491389403f375ec5eeb81df2b9e372240bfbd1343f73f87ea3d4a0559c98dd3abf7fa35e5c217645db07feee2cc61befe22f13fab3e195e62f06c30c48964fbdcc1230499d6a912110461238d21ca50a0642d447662d9542a4c377bcc52a8abf152ff2c37efa7d75688a7d5adc0779a83ced8bebb63e4eabb3f920960ff2c14ddfe0050fe68a7e7a2c3e092ff20978919f14af488844463ae64d44e0a750aabf86b4a84b48e432a61e49c6d2904694862223a20387a84cd00b8cef464d7d0a5ed7d862427f34e933544c67be6cd86a635018cd42e571d0572ddbdb15bbedcdd364787a3e0e633479dbcbf9fabc99eb701f67c3e34dcfe227234c401e4a0d6388a4e36d749a97a602a0668507b34f154e23da894ed33628920c7c3fa55e58415c1a09a93f70f7f42eedc1c45f2d603facc91f1e164359586d9e17d9e7a81eab8d6711487b323c9a5c4d6ed62ffb47ff004c20ceae58fdc2e49304eccb9727c8a585a58412381f885882710a961b7445a4057deab0d7861891f64c38e5783afed01ba2b010fcedc12309af57778f8503b71e9d85348007ca8896ce232f198b187bcb502434eded35f0514c84504e1080d7581e5804127f06bc3eeef808ab1a656e37ab2f33a3e96c1e8bcdddd8b7dacb69b770bfad161a6fe94a67ad5c4ed7270e2afeabde9e7f57bafe36b6980c012c7b0405f39c1b230383ac1133aa71e0220dc80e0454cdc0cf424a503508934e0aa2844f47d2898fd84ac1f1cb27c9fe7833a3388cbb0fe59e5cf1a3ab8fd7653fa9cff78b56bdd029e8357f50ec0d5de904b22be8faac49b29f32c4877c7fe94b5eb8f41520688918499a6e4c28714c50aea9f411474325a0c75c248e184ba34b6db251c4747449784fd8ebd297523e1dee4a2876d141fa445301ce841034a641798a9535383511a5d917241dd84153434750815b2ed907ea8513618cfdfd8babab816ad667c58d39cab2db666badbda98e78399fe96e36a5dd7e5c3e254c0161572cde63f40f5a5cbdb4b6ad71c4261825228428a48d30312a04699df33810c8046d604c46c39dd3917312bd03ede1ea1d6127b56d193c383425d23002aa54449ac1776a582a91d35431f24c803ba3e0f452cfb7323c75e1a6ed2a5c09718eb0346a5da76d89ec2738f28656dbd5e6e8795a6e97bdd643f91c7a6bbb1f1f6a3af3f4184ac3fa29611a08bb62f9fe9f33ac18f2b20beb4344a601fdc2e8d4d8409949232eb40e1485d46086b5b0d1a6f9d7311a028ca405505035f156c23851271319c14f61c80eb8000b9f4e38575122ab38c8228449015f2c4910405a3a5e90c6742218f10ef206ec8934e44c90c4aa83f41d857ffffe61d8f5552fe6dcfea1b46b9b0c9916b3d95ceec966f699ce3cb75eefee9fede909abe944aa6b4e9cfee700c62f2d0f459ebc0f28b90f5649a69003a7a50df86d0e6071a582f7c1109f56f1b1d30e9c3ad53abe1db1c2e449798842cc0b8a79ebd3643c67834ecd13126313b524ca33e3412dad06b9249a726031a499f7d182d10bc69d4920114ec7c2517ee3d995f5836e6e26ad5c9199c7e3fdc24ec6c7955d9a4ef3c8bb0b591c3b768d82e517d545b15899f7e69daccef345d3144af372aff2ac5cfd38f5fbd33d033cadae5eb180cfbe1cb09b1ec59f014b8db017b67513ac08b7f09ff1016be3b1625130501309e69c43aa6720c5c3293a1a91863e716b0143f7b6fe88f5c9cc6208ac81ba34aa389521d3447585b0b0160c3ed2d273249d01036c82408240fc3538b585a59352634c4d9b9f0fd8eeb92ef7bb19cbf59dec1965828f4f99d9c43e08d7a9cf3ae1f9aa0a377d685487fe21e37d6180b52a2c5acd43cb1f1787b9f3c3d2b0fa1eb06b86167fbd82ddf2287e32c0d2cc1385ac084a190761356d63915404a1b837c24783140567e2d3d936323887258bd42a1aa30d6926dca703d6a0f345be71acced832bb29765b6d95ad1e1fcb949bd2e13015d3fa9f8f41fbb8ff6ba00bbcbe2a375636238ff5d6b8f1b43f3ed3e164f2d0280dfbcbdc5bbcd2c08bcbcf23f93cbcce9fbc7bfd63f8d9d0629ca57ab807f5f248c5001135a4e321802f974e15178c86b4e9098c1de40a5ea2e802e669a9cc7b1ac3cfa05d1fa3b58da3fcf830a1f3d5e1703fa199fdae631f96e5e3f3ee498daad5a7b7687176c5eabdfc5ab46e790c3f195a60dfac21462a0b7e4ba5ad7269eaa24e474ff0206c3aeb8678ea522ea9c1722109cae6d2e97096622046bf470b2763ff9f495ef4cb379bfff824cbd9f338968fca14c6a2380935bb1e4e87eab8b4ca4f0ae3d578710a57f25c57acadd22f9ee475e3a3380318275a5e33cbdf6286456a72488d3316323e78f985c1c805c7d311219210970ea8893612124c546f00431a617e72562a7c65082e488948ead0872ba8d4dec3522d1298815cd4e874fcbcd2e97258a1f0db7e3dea7940ee2c6004a5b322e84dd30c6e199ef897a72716e6e34aa73c1e6797bb85bf5f0fe7bdecbeff94992e8683239ee4baa77b84fe7360c9674d4dfa68e1eb966fe9763e7ffd11a0172e6d08cb011fc114843a630316587aa08a6229d220a0745eb948ab0e8a0b96fa7318f31026857f0fe8ebd246ea64d5e97c5f4b290a927ba90348a062d4ab0899029624ad79a44987698a9780ec5450091902498501aace00fa32c69f893b76e376e2fb2c3f96caa5a7ce9867bbf558ac0c72aab3ac4efb99da7250dc3d9eb6bcfffee3e3e2656eb95e2d17dd49b14ac77edc7e3844e35da1ba3a342b99c756419c4a602a5c5ed3baff791b43e007fdfd3efefac338c398b89831c80b79dafce670da4b6c9cf54242a843ce381e0873c12bcf880e5e701614f6694fd1fb03a3913a652c8d4324de13095c7248400307350c043055d2306a0053a282221e3380da49af21fdf41a5c9de152bb732248d27c62c2eeb8fadba36c03ef1695d5b6ecf548ae0b23d939e61acb7bf69c1b0fb2e2a1325f744ea5445c779a1cfec7445910a00b8f89007b6611551123a223f55408150de483a901d64aab19885a4c47f85a9d8e74081c2830c2be290020a94fce22410018b8416db592c9233a303308348b094ad3d971a95c0a4849c6581a18e0525c4f33b2834e8361a93d0f184d36eeb612d3e71600f23d966de6437edfe6d5fba7d5d3b6db286e6bcf8565be1d06ad11ef9e02a6ae3bf20bfd53d6671360172a1807e7c6d3222a64168a324939512942820513517a0f82e50d8388e6454cba165d8a6fd6bd07ec55c15e8ee92542d9940e2821298d69ce0697d6694a53964023445fcab5b01a818639e0d0f074b809e4a2ca7ca460a9c244ffdb6cdc274c65ed4cbabbc67db63f9e6dba995a1f172a8571a9ccd661b65d7527a593a3e724f8102585f80a3377663cebe5dfd8efb31bf17740bbb01d2344cc99c51ca5e3b7086336a4331e204b14e9d437c81e2173f008340878d4182c7d48dd3911bf07ed25975aadcdf2b7d7f93f779566b0ade76bf3aff4cb7fff3f19938b64cfa50000"],
              { 'access-control-allow-headers': 'content-type, authorization',
                'content-encoding': 'gzip',
                'content-type': 'application/json; charset=utf-8',
                vary: 'Accept-Encoding',
                'transfer-encoding': 'chunked'
              });

      nock('https://test.bitgo.com:443')
          .persist()
          .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500&skip=10')
          .reply(200, {"transactions": [], count: 0});

      nock('https://test.bitgo.com:443')
          .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/addresses')
          .reply(200, {"addresses":[{"chain":0,"index":0,"path":"/0/0","address":"2NG3eraWTiDSTGYWX4Xc6qAH1rwEHwXiHr9"},{"chain":0,"index":1,"path":"/0/1","address":"2NAvfxq4AmDE89eJbAjNK2gXu1kfFNu99Bo"}],"start":0,"count":2,"total":2,"hasMore":false});

    });

    it('listreceivedbyaddress', function() {
      return callRPC('listreceivedbyaddress')
          .then(function(result) {
            result.should.eql(results.receivedbyaddressListTxt1);
          });
    });

    it('listreceivedbyaddress 77369', function() {
      return callRPC('listreceivedbyaddress', 77369)
          .then(function(result) {
            result.should.eql(results.receivedbyaddressListTxt2);
          });
    });

    it('listreceivedbyaddress 0 true', function() {
      return callRPC('listreceivedbyaddress', 0, true)
          .then(function(result) {
            result.should.eql(results.receivedbyaddressListTxt3);
          });
    });

    it('bad param listreceivedbyaddress 0 hiben', function() {
      return callRPC('listreceivedbyaddress', 0, 'hiben')
          .then(expectError, function(err) {
            err.message.should.match(/Instant flag was not a boolean/);
          });
    });

    it('listreceivedbyaddress no transactions', function() {
      nock.cleanAll();
      nock('https://test.bitgo.com:443')
          .persist()
          .get('/api/v1/wallet/2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX/tx?limit=500')
          .reply(200, {"transactions": [], count: 0});
      return callRPC('listreceivedbyaddress')
          .then(function(result) {
            result.should.eql([]);
          });
    });


  });
});
