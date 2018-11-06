// Copyright 2014 BitGo, Inc.  All Rights Reserved.
//

var ArgumentParser = require('argparse').ArgumentParser;
var assert = require('assert');
var bitgo = require('bitgo');
var bitcoin = bitgo.bitcoin;
var ini = require('ini');
var rpc = require('json-rpc2');
var Q = require('q');
var fs = require('fs');
var _ = require('lodash');
var winston = require('winston');
_.string = require('underscore.string');
var pjson = require('../package.json');
var BITGOD_VERSION = pjson.version;

Q.longStackSupport = true;

var BitGoD = function () {
  this.loggingEnabled = true;

  // Set up logger
  var logLevels = {
    debug: 2,
    info: 1,
    error: 0
  };

  var logColors = {
    debug: 'grey',
    info: 'blue',
    error: 'red',
    fatal: 'magenta'
  };

  this.logger = new(winston.Logger)({
    colors: logColors,
    levels: logLevels,
    transports: [],
  });
  this.logger.add(winston.transports.Console, { level: 'info', timestamp: true, colorize: true });

  console.log = this.logger.info.bind(this.logger);
  console.info = this.logger.info.bind(this.logger);
  console.warn = this.logger.error.bind(this.logger);
  console.error = this.logger.error.bind(this.logger);
};

BitGoD.prototype.setLoggingEnabled = function(loggingEnabled) {
  this.loggingEnabled = !!loggingEnabled;
  return this;
};

BitGoD.prototype.getConfig = function(confFile) {
  var iniData;
  try {
    iniData = fs.readFileSync(confFile || '/etc/bitgod.conf', 'utf-8');
  } catch (err) {
    // Only throw on failure to read if confFile file was explcitly specified
    if (confFile) {
      throw new Error("couldn't read config file " + confFile);
    }
  }
  return iniData ? ini.parse(iniData) : {};
};

/**
 * Parse command line args (from process.argv, or directly from args, if specified)
 *
 * @param   {String[]} args   optional direct-specified args (good for testing)
 * @returns {Object}      object with parsed args
 */
BitGoD.prototype.getArgs = function(args) {
  var parser = new ArgumentParser({
    version: BITGOD_VERSION,
    addHelp:true,
    description: 'BitGoD'
  });

  parser.addArgument(
    ['-conf'], {
      help: 'Specify configuration file (default: /etc/bitgod.conf)'
    }
  );

  parser.addArgument(
    ['-env'], {
      help: 'BitGo environment to use [prod|test (default)]'
  });

  parser.addArgument(
    ['-rpcbind'], {
      help: 'Bind to given address to listen for JSON-RPC connections (default: localhost)',
  });

  parser.addArgument(
    ['-rpcport'], {
      help: 'Listen for JSON-RPC connections on RPCPORT (default: 9332 or testnet: 19332)'
  });

  parser.addArgument(
    ['-rpcuser'], {
      help: 'Username for RPC basic auth (default: none)'
  });

  parser.addArgument(
    ['-rpcpassword'], {
      help: 'Password for RPC basic auth (default: none)'
  });

  parser.addArgument(
    ['-rpcssl'], {
      action: 'storeConst',
      constant: true,
      help: 'Listen using JSON RPC with SSL'
  });

  parser.addArgument(
    ['-rpcsslkey'], {
      help: 'Path to SSL Key when listening with SSL is on'
  });

  parser.addArgument(
    ['-rpcsslcert'], {
      help: 'Path to SSL Cert when listening with SSL is on'
  });

  parser.addArgument(
    ['-proxyhost'], {
      help: 'Host for proxied bitcoind JSON-RPC (default: localhost)'
  });

  parser.addArgument(
    ['-proxyport'], {
      help: 'Port for proxied bitcoind JSON-RPC (default: 8332 or testnet: 18332)',
  });

  parser.addArgument(
    ['-proxyuser'], {
      help: 'Username for proxied bitcoind JSON-RPC (default: bitcoinrpc)'
  });

  parser.addArgument(
    ['-proxypassword'], {
      help: 'Password for proxied bitcoind JSON-RPC',
  });

  parser.addArgument(
    ['-proxyrpcssl'], {
      action: 'storeConst',
      constant: true,
      help: 'Use SSL when connecting to proxied bitcoind JSON-RPC',
  });

  parser.addArgument(
    ['-proxyrpcsslallowunauthorizedcerts'], {
      action: 'storeConst',
      constant: true,
      help: 'Allow SSL certs which are self-signed'
  });

  parser.addArgument(
    ['-proxy'], {
      help: 'Proxy to bitcoind JSON-RPC backend for non-wallet commands'
  });

  parser.addArgument(
    ['-masqueradeaccount'], {
      help: 'Ignore wallet account values and masquerade transactions as being in this account'
  });

  parser.addArgument(
    ['-validate'], {
      choices: ['loose', 'strict'],
      help: 'Validate transaction data against local bitcoind (requires -proxy)'
  });

  parser.addArgument(
    ['-minunspentstarget'], {
      help: 'The number of UTXO\'s that will exist after a transaction is sent'
  });

  parser.addArgument(
    ['-logfile'], {
      help: 'Log file location'
  });

  return parser.parseArgs(args);
};

BitGoD.prototype.setupProxy = function(config) {
  var self = this;

  if (this.client) {
    throw new Error('proxy already set up');
  }

  var commandGroups = {
    blockchain: 'getbestblockhash getblock getblockchaininfo getblockcount getblockhash getchaintips getdifficulty getmempoolinfo getrawmempool gettxout gettxoutproof gettxoutsetinfo verifychain verifytxoutproof',
    mining: 'getmininginfo getnetworkhashps prioritisetransaction submitblock',
    network: 'addnode clearbanned disconnectnode getaddednodeinfo getconnectioncount getnettotals getnetworkinfo getpeerinfo listbanned ping setban',
    tx: 'createrawtransaction decoderawtransaction decodescript fundrawtransaction getrawtransaction sendrawtransaction signrawtransaction',
    util: 'createmultisig estimatefee estimatepriority estimatesmartfee verifymessage'
  };

  var proxyPort = config.proxyport || (bitgo.getNetwork() === 'bitcoin' ? 8332 : 18332);

  this.client = rpc.Client.$create(
    proxyPort,
    config.proxyhost,
    config.proxyuser,
    config.proxypassword
  );

  var proxyCommand = function(cmd) {
    self.server.expose(cmd, function(args, opt, callback) {
      self.client.call(cmd, args, { https: !!config.proxyrpcssl, rejectUnauthorized: !config.proxyrpcsslallowunauthorizedcerts }, callback);
    });
  };

  // Proxy all the commands
  for (var group in commandGroups) {
    commandGroups[group].split(' ').forEach(proxyCommand);
  }

  // Setup promis-ified method to call a method in bitcoind
  this.callLocalMethod = function(cmd, args) {
    return Q.nbind(this.client.call, this.client)(cmd, args, { https: !!config.proxyrpcssl, rejectUnauthorized: !config.proxyrpcsslallowunauthorizedcerts });
  };

  // Verify we can actually connect
  // https://bitcoin.org/en/developer-reference#getblockchaininfo
  return this.callLocalMethod('getblockchaininfo', [])
  .then(function(result) {
    var bitcoindNetwork;
    switch (result.chain) {
      case 'main':
        bitcoindNetwork = 'bitcoin';
        break;
      case 'test':
        bitcoindNetwork = 'testnet';
        break;
      default:
        // regtest is unsupported
        throw new Error('unknown network ' + result.chain);
    }
    if (bitcoindNetwork !== bitgo.getNetwork()) {
      throw new Error('bitcoind using ' + bitcoindNetwork + ', bitgod using ' + bitgo.getNetwork());
    }
    console.log('Connected to proxy bitcoind at ' + [config.proxyhost, proxyPort].join(':'));
    console.dir(result);
  })
  .catch(function(err) {
    throw new Error('Error connecting to proxy: ' + err.message);
  })
  .then(function() {
    // If validation is on, ensure that bitcoind has txindex=1
    if (self.validate) {
      // Random old spent transactions that bitcoind won't have unless in txindex mode
      var txid = (bitgo.getNetwork() === 'bitcoin') ?
        'c65602d4310c1ca9c560705176ebc01c34a4bac40a3af432be839df1cf8dd87c' :
        '44954268b32d386733f64d457bc933bf323f31f3596b90becc718a5b7cbfce8a';
      return self.getTransactionLocal(txid)
      .catch(function(err) {
        throw new Error('bitcoind must have txindex enabled to use validation');
      });
    }
  });
};

BitGoD.prototype.getTransactionLocal = function(txhash) {
  return this.callLocalMethod('getrawtransaction', [txhash])
  .then(function(hex) {
    return bitcoin.Transaction.fromHex(hex);
  });
};

BitGoD.prototype.getTransactionsLocal = function(txhashes) {
  var self = this;
  return Q.allSettled(
    txhashes.map(function(txhash) {
      return self.getTransactionLocal(txhash);
    })
  )
  .then(function(result) {
    return _.pluck(result, 'value');
  });
};

BitGoD.prototype.getBlockLocal = function(blockhash) {
  return this.callLocalMethod('getblock', [blockhash]);
};

BitGoD.prototype.getBlocksLocal = function(blockhashes) {
  var self = this;
  return Q.allSettled(
    blockhashes.map(function(blockhash) {
      return self.getBlockLocal(blockhash);
    })
  )
  .then(function(result) {
    return _.pluck(result, 'value');
  });
};

BitGoD.prototype.ensureWallet = function() {
  if (!this.wallet) {
    throw new Error('Not connected to BitGo wallet');
  }
};

BitGoD.prototype.getSigningKeychain = function() {
  if (!this.keychain) {
    throw new Error('No keychain');
  }
  if (!this.keychain.xprv && !this.keychain.encryptedXprv) {
    throw new Error('No keychain xprv');
  }
  var xprv = this.keychain.xprv;
  if (!xprv) {
    if (!this.passphrase) {
      throw this.error('Error: Please use walletpassphrase or setkeychain first.', -13);
    }
    xprv = this.bitgo.decrypt({
      password: this.passphrase,
      input: this.keychain.encryptedXprv
    });
  }
  return {
    xpub: this.keychain.xpub,
    path: this.keychain.path,
    xprv: xprv
  };
};

BitGoD.prototype.toBTC = function(satoshis) {
  return (satoshis / 1e8);
};

BitGoD.prototype.getNumber = function(val, defaultValue) {
  if (typeof(val) === 'undefined') {
    return defaultValue;
  }
  var result = Number(val);
  if (isNaN(result)) {
    throw this.error('value is not a number', -1);
  }
  return result;
};

BitGoD.prototype.getInteger = function(val, defaultValue) {
  var number = this.getNumber(val, defaultValue);
  var integer = parseInt(number);
  if (integer != number) {
    throw this.error('value is type real, expected int', -1);
  }
  return integer;
};

BitGoD.prototype.ensureBlankAccount = function(account) {
  var self = this;
  if (typeof(account) !== 'undefined' && account !== '' && !self.masqueradeAccount) {
    throw new Error('accounts not supported - use blank account only');
  }
};

BitGoD.prototype.error = function(message, code) {
  if (!code) {
    throw new Error(message);
  }
  var MyError = rpc.Error.AbstractError.$define('MyError', {code: code});
  return new MyError(message);
};

BitGoD.prototype.log = function() {
  if (this.loggingEnabled) {
    return this.logger.info.apply(this.logger, arguments);
  }
};

BitGoD.prototype.logError = function() {
  if (this.loggingEnabled) {
    return this.logger.error.apply(this.logger, arguments);
  }
};

BitGoD.prototype.modifyError = function(err) {
  var message;
  if (typeof(err) === 'string') {
    message = err;
  } else {
    message = err.message;
  }
  if (!message) {
    return err;
  }
  if (message === 'Insufficient funds') {
    return this.error('Insufficient funds', -6);
  }
  if (message.indexOf('invalid bitcoin address') !== -1) {
    return this.error('Invalid Bitcoin address', -5);
  }
  if (message.indexOf('transaction not found') !== -1) {
    return this.error('Invalid or non-wallet transaction id', -5);
  }
  if (message.indexOf('sequence id not found') !== -1) {
    return this.error('Invalid or non-wallet sequence id', -5);
  }
  if (message.indexOf('invalid amount') !== -1) {
    return this.error('Invalid amount', -3);
  }
  if (message.indexOf('must have at least one recipient') !== -1) {
    return this.error('Transaction amounts must be positive', -6);
  }
  if (message.indexOf('exceeds daily limit') !== -1) {
    message = 'Exceeds daily policy limit';
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10501);
  }
  if (message.indexOf('exceeds per-transaction limit') !== -1) {
    message = 'Exceeds per-transaction limit';
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10502);
  }
  if (message.indexOf('violates bitcoin address') !== -1) {
    message = message[0].toUpperCase() + message.substring(1);
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10503);
  }
  if (message.indexOf('exceeds a spending limit') !== -1) {
    message = 'Exceeds a spending limit';
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10504);
  }
  if (message.indexOf('webhook failed to return approval') !== -1) {
    message = 'Webhook failed to return approval';
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10505);
  }
  if (message.indexOf('violates weekday policy rule') !== -1) {
    message = 'Violates weekday policy rule';
    if (err.pendingApproval) {
      message += ', pendingApproval=' + err.pendingApproval;
    }
    return this.error(message, -10506);
  }

  return this.error(message, -10600);
};

BitGoD.prototype.getWallet = function(id) {
  id = id || (this.wallet && this.wallet.id());
  return this.bitgo.wallets().get({id: id});
};

BitGoD.prototype.handleNOOP = function() {
  return "";
};

BitGoD.prototype.handleSetToken = function(token) {
  var self = this;
  this.bitgo._token = token;
  return this.bitgo.me()
  .then(function(user) {
    self.bitgo._user = user;
    return 'Authenticated as BitGo user: ' + user.username;
  });
};

BitGoD.prototype.handleSetWallet = function(walletId) {
  var self = this;
  if (this.wallet && this.wallet.id() === walletId) {
    return 'Set wallet: ' + walletId;
  }
  return this.getWallet(walletId)
  .then(function(wallet) {
    self.wallet = wallet;
    return 'Set wallet: ' + wallet.id();
  });
};

BitGoD.prototype.handleValidateAddress = function(address) {
  var result = {
    isvalid: this.bitgo.verifyAddress({ address: address })
  };
  if (!result.isvalid) {
    return result;
  }
  result.address = address;
  result.scriptPubKey = bitcoin.address.toOutputScript(address, bitcoin.getNetwork()).toString('hex');
  // Missing fields for our own addresses (need API support):
  // ismine
  // iswatchonly
  // isscript
  // pubkey
  // iscompressed
  // account
  return result;
};

BitGoD.prototype.handleSession = function() {
  return this.bitgo.session()
  .then(function(session) {
    if (session.unlock) {
      session.unlock.secondsRemaining = Math.floor((new Date(session.unlock.expires) - new Date()) / 1000);
    }
    return session;
  });
};

BitGoD.prototype.handleUnlock = function(otp, seconds) {
  seconds = this.getNumber(seconds, 600);
  return this.bitgo.unlock({otp: otp, duration: seconds})
  .then(function() {
    return 'Unlocked';
  });
};

BitGoD.prototype.handleLock = function() {
  return this.bitgo.lock()
  .then(function() {
    return "Locked";
  });
};

BitGoD.prototype.handleFreezeWallet = function(seconds) {
  var self = this;
  seconds = this.getNumber(seconds);
  this.ensureWallet();
  return this.wallet.freeze({ duration: seconds });
};

/**
 * Set the wallet keychain xprv, after fetching the keychain from the server, and validating
 * the xprv against the xpub.  This call can be used by customers who don't have an encryptedXprv
 * set on their server-side keychain.
 *
 * @param   {String} xprv   the BIP32 xprv for the user's keychain
 * @returns {String}        message on success, or throws
 */
BitGoD.prototype.handleSetKeychain = function(xprv) {
  var self = this;

  this.ensureWallet();
  if (xprv === '') {
    delete this.keychain;
    return 'Keychain removed';
  }
  var bip32;
  try {
    bip32 = bitcoin.HDNode.fromBase58(xprv);
    this.ensureWallet();
    if (bip32.toBase58() !== xprv) {
      throw new Error();
    }
  } catch (err) {
    throw new Error('Invalid keychain xprv');
  }
  var xpub = bip32.neutered().toBase58();

  return this.bitgo.keychains().get({xpub: xpub})
  .then(function(keychain) {
    keychain.xprv = xprv;
    self.keychain = keychain;
    return 'Keychain set';
  });
};

/**
 * Set the wallet passphrase for a specified number of seconds.
 * Has slightly different behavior if a keychain is already set (using setkeychain)
 *
 * If keychain is set:
 *   - we encrypt the xprv with the passphrase, and then dump the unencrypted version
 *
 * If keychain is not set, grab from the server, and attempt to decrypt encryptedXprv.
 * If it succeeds, then keep the passphrase in memory for the specified time period.
 *
 * @param   {String} passphrase    the passphrase
 * @param   {Number} timeout       the timeout in seconds
 * @returns {Promise}              undefined on success, or throws
 */
BitGoD.prototype.handleWalletPassphrase = function(passphrase, timeout) {
  var self = this;
  timeout = this.getNumber(timeout, 0);
  if (!timeout) {
    throw new Error('timeout must be specified');
  }
  var error = this.error('Error: The wallet passphrase entered was incorrect.', -14);
  this.ensureWallet();

  return Q().then(function() {
    // If we don't have a keychain set yet, fetch it from the wallet
    if (!self.keychain) {
      return self.bitgo.keychains().get({xpub: self.wallet.keychains[0].xpub })
      .then(function(keychain) {
        self.keychain = keychain;
      });
    }
  })
  .then(function() {
    if (self.keychain.encryptedXprv) {
      try {
        self.bitgo.decrypt({
          password: passphrase,
          input: self.keychain.encryptedXprv
        });
      } catch (e) {
        throw error;
      }
    }
    // Handle case where we already have a keychain set, just not encrypted
    if (self.keychain.xprv) {
      self.keychain.encryptedXprv = self.bitgo.encrypt({
        password: passphrase,
        input: self.keychain.xprv
      });
    }

    // Make sure we don't keep unencrypted version
    delete self.keychain.xprv;

    self.passphrase = passphrase;

    self.passPhraseExpires = new Date(new Date().getTime() + timeout * 1000);

    // Delete the passphrase in timeout seconds (or immediately if <= 0)
    var passphraseTimeOutHandler = function() {
      if (self.passPhraseExpires <= new Date()) {
        delete self.passphrase;
      } else {
        setTimeout(passphraseTimeOutHandler, 1000);
      }
    };

    passphraseTimeOutHandler();
  });
};

BitGoD.prototype.handleWalletLock = function() {
  delete this.passphrase;
  delete this.keychain.xprv;
};

BitGoD.prototype.newAddress = function(chain) {
  this.ensureWallet();
  return this.wallet.createAddress({ chain: chain })
  .then(function(address) {
    return address.address;
  });
};

BitGoD.prototype.handleGetNewAddress = function() {
  const isSegwit = this.bitgo.getConstants().enableSegwit;
  const defaultChain = isSegwit ? 10 : 0; // we use 10 for segwit receive addresses and 0 for non-segwit
  return this.newAddress(defaultChain);
};

BitGoD.prototype.handleGetAddressesByAccount = function(account) {
  this.ensureWallet();
  this.ensureBlankAccount(account);

  var self = this;
  var listOfAddressLists = [];
  var getAddressesByAccountInternal = function (skip) {
    return self.wallet.addresses({skip: skip})
    .then(function (addrsPage) {
      listOfAddressLists.push(addrsPage.addresses);
      if (addrsPage.hasMore) {
        return getAddressesByAccountInternal(skip + addrsPage.count);
      } else {
        return _(listOfAddressLists).flatten().pluck('address').value();
      }
    });
  };
  return getAddressesByAccountInternal(0);
};

BitGoD.prototype.handleGetRawChangeAddress = function() {
  const isSegwit = this.bitgo.getConstants().enableSegwit;
  const defaultChain = isSegwit ? 11 : 1; // we use 11 for segwit change addresses and 1 for non-segwit
  return this.newAddress(defaultChain);
};

BitGoD.prototype.getBalanceFromUnspents = function(minConfirms, maxConfirms, ignoreConfirmsForChange, minUnspentSize) {
  var self = this;
  return this.handleListUnspent(minConfirms, maxConfirms, undefined, ignoreConfirmsForChange, minUnspentSize)
  .then(function(unspents) {
    return self.toBTC(
      Math.round(unspents.reduce(function(prev, unspent) { return prev + unspent.satoshis; }, 0))
    );
  });
};

BitGoD.prototype.getBalance = function(minConfirms, minUnspentSize) {
  assert(typeof(minConfirms) !== 'undefined');
  var self = this;
  return Q().then(function() {
    if (minConfirms >= 2) {
      return self.getBalanceFromUnspents(minConfirms, 9999999, true, minUnspentSize);
    }
    return self.getWallet()
    .then(function(wallet) {
      var balance = minConfirms == 1 ? wallet.spendableBalance() : wallet.balance();
      return self.toBTC(balance);
    });
  }).then(function(balance) {
    return balance;
  });
};

BitGoD.prototype.handleGetBalance = function(account, minConfirms, minUnspentSize) {
  this.ensureWallet();
  this.ensureBlankAccount(account);
  minConfirms = this.getNumber(minConfirms, 1);
  return this.getBalance(minConfirms, minUnspentSize);
};

BitGoD.prototype.handleGetUnconfirmedBalance = function() {
  var self = this;
  this.ensureWallet();
  return this.getWallet()
  .then(function(wallet) {
    return self.toBTC(wallet.balance() - wallet.confirmedBalance());
  });
};

BitGoD.prototype.handleListAccounts = function(minConfirms) {
  var self = this;

  return this.handleGetBalance('', minConfirms)
  .then(function(balance) {
    var accounts = {};

    if (self.masqueradeAccount) {
      accounts[self.masqueradeAccount] = balance;
    } else {
      accounts[""] = balance;
    }

    return accounts;
  });
};

BitGoD.prototype.handleListUnspent = function(minConfirms, maxConfirms, addresses, ignoreConfirmsForChanges, minUnspentSize) {
  this.ensureWallet();
  var self = this;
  minConfirms = this.getNumber(minConfirms, 1);
  maxConfirms = this.getNumber(maxConfirms, 9999999);
  minUnspentSize = this.getNumber(minUnspentSize);

  // The limit defined here gets clamped server-side (currently to 5000).
  // Locally it will define the maximum number of unspents to aggregate through pagination.
  // In this call we want to fetch all requests and use a big page size in order to avoid timeouts.
  // Ideally we should be able to define page size and total limit separately, but this does the job for now.
  // See BG-2878
  var limit = 21000000 * 1e8;

  return this.wallet.unspents({ minConfirms: minConfirms, minSize: minUnspentSize, limit: limit })
  .then(function(unspents) {
    return unspents.map(function(u) {
      const chain = parseInt(u.chainPath.split('/')[1], 10);
      const isValidChain = _.isNumber(chain) && !isNaN(chain);
      return {
        txid: u.tx_hash,
        vout: u.tx_output_n,
        address: u.address,
        account: self.masqueradeAccount || '',
        scriptPubKey: u.script,
        redeemScript: u.redeemScript,
        witnessScript: u.witnessScript,
        isSegwit: isValidChain && (chain === 10 || chain === 11),
        amount: self.toBTC(u.value),
        satoshis: u.value,  // non-standard field
        confirmations: u.confirmations,
        isChange: u.isChange,
        instant: u.instant
      };
    })
    .filter(function(u) {
      return ((u.confirmations >= minConfirms && u.confirmations <= maxConfirms) ||
              (ignoreConfirmsForChanges && u.isChange));
    });
  });
};

/**
 * Take a transaction object and split it into bitcoind-style outputs, adding
 * them to a list. If keychain is provided, and outputs have receivedTravelInfo
 * attached, the travelInfo will be decrypted.
 * @param   {Object} tx         transaction
 * @param   {Array} outputList
 * @param   {Object} keychain   a BitGo private keychain
 */
BitGoD.prototype.processTxAndAddOutputsToList = function(tx, outputList, keychain) {
  var self = this;

  outputList = outputList || [];
  tx.entries.every(function(entry) {
    if (entry.account === self.wallet.id()) {
      tx.netValue = entry.value;
      return false;
    }
    return true;
  });

  tx.amount = 0;

  if (keychain && tx.receivedTravelInfo && tx.receivedTravelInfo.length) {
    tx = this.bitgo.travelRule().decryptReceivedTravelInfo({ tx: tx, keychain: keychain });
  }

  var receivedTravelInfoByIndex = _.indexBy(tx.receivedTravelInfo, 'outputIndex');
  var sentTravelInfoByIndex = _.indexBy(tx.sentTravelInfo, 'outputIndex');

  var outputCount = tx.outputs.length;
  tx.outputs.forEach(function(output, outputIndex) {
    // Skip the output if it's an overall spend, but we have a positive output to us that
    // is last (the change address)
    // or if it's an overall receive, and there's a positive output elsewhere.
    // TODO: fix this the right way to know whether it's change address if change
    // addresses are no longer always put last.
    if ((tx.netValue < 0 && (output.chain === 1 || output.chain === 11)) ||
    (tx.netValue > 0 && !output.isMine) ) {
      return;
    }
    output.netValue = output.isMine ? output.value : -output.value;
    tx.amount += output.netValue; // tally the total tx value (not including fees), used when returning gettransaction
    var record = {
      account: self.masqueradeAccount || '',
      address: output.account,
      category:  output.isMine ? 'receive' : 'send',
      amount: self.toBTC(output.netValue),
      vout: output.vout,
      confirmations: tx.confirmations,
      blockhash: tx.blockhash,
      // blockindex: 0,  // don't have it
      // blocktime: '',  // don't have it
      txid: tx.id,
      time: new Date(tx.date).getTime() / 1000,
      timereceived: new Date(tx.date).getTime() / 1000,
      instant: tx.instant,
      instantId: tx.instantId,

      // Non-standard fields (could strip after validation)
      height: tx.height,
      satoshis: output.value
    };
    if (tx.netValue < 0) {
      record.fee = self.toBTC(-tx.fee);
    }
    if (sentTravelInfoByIndex[outputIndex]) {
      record.sentTravelInfo = sentTravelInfoByIndex[outputIndex];
    }
    if (receivedTravelInfoByIndex[outputIndex]) {
      record.receivedTravelInfo = receivedTravelInfoByIndex[outputIndex];
    }
    outputList.push(record);
  });

  return outputList;
};

/**
 * Validate a list of tx outputs against the local bitcoind
 * The following are checked for each output:
 *  1. The txid exists
 *  2. The blockhash exists
 *  3. The value matches
 *  4. The address matches
 *  5. The output's transaction is included in the specified block
 *  6. The output's block has the specified height / confirms
 *
 * @param   {Array} outputs   list of outputs (in form returned by listtransactions)
 * @returns {Array}           the outputs, or throws error
 */
BitGoD.prototype.validateTxOutputs = function(outputs) {
  var self = this;

  var throwValidationError = function(output, msg, serverVal, localVal) {
    if (output) {
      console.log('Validation failure for output:');
      console.dir(output);
    }
    var prefix = 'Validation failed';
    if (output) {
      prefix = prefix + ' for output ' + output.txid + ':' + output.vout;
    }
    var postfix = "";
    if (serverVal && localVal) {
      postfix = " " + JSON.stringify({server: serverVal, local: localVal});
    }
    throw new Error(prefix + ': ' + msg + postfix);
  };

  // Divide outputs into 3 sets (0-confirm, 1-confirm, more-than-1-confirm)
  var outputGroup = function(output) {
    var confirmations = output.confirmations || 0;
    assert(confirmations >= 0);
    switch (confirmations) {
      case 0:
      case 1:
        return confirmations;
      default:
        return 2;
    }
  };

  var groups = [0, 1, 2];

  var outputGroups = groups.map(function(group) {
    return outputs.filter(function(o) { return outputGroup(o) === group; });
  });

  // Create corresponding sets of txids
  var txidGroups = outputGroups.map(function(outputSet) {
    return _.chain(outputSet).pluck('txid').uniq().value();
  });

  // Create corresponding sets of blockids
  var blockidGroups = [
    [],
    _.chain(outputGroups[1]).pluck('blockhash').uniq().value(),
    _.chain(outputGroups[2]).pluck('blockhash').uniq().value()
  ];
  // there should only be 1 top block
  assert(blockidGroups[1].length <= 1);

  return Q.all([
    self.getTransactionsLocal(txidGroups[0]),
    self.getTransactionsLocal(txidGroups[1]),
    self.getTransactionsLocal(txidGroups[2]),
    [],
    self.getBlocksLocal(blockidGroups[1]),
    self.getBlocksLocal(blockidGroups[2])
  ])
  .then(function(result) {
    var txGroups = result.slice(0, 3);
    var blockGroups = result.slice(3, 6);

    // Build sets of maps from txid to tx
    var txByIdGroups = groups.map(function(group) {
      return _.zipObject(txidGroups[group], txGroups[group]);
    });

    // Build sets of maps from blockid to block
    var blockByIdGroups = groups.map(function(group) {
      return _.zipObject(blockidGroups[group], blockGroups[group]);
    });

    // In strict mode, we validate anything with 1 confirm or more. This means
    // validation can fail if the local bitcoind does not have the current top block.
    // In normal (loose) validation mode, we only require existence of blocks/transactions
    // which have 2+ confirms.
    var minGroupToValidate = self.validate === 'strict' ? 1 : 2;

    groups.slice(minGroupToValidate).forEach(function(group) {
      var failedTransactions = txidGroups[group].filter(function(txid) { return !txByIdGroups[group][txid]; });
      if (failedTransactions.length > 0) {
        throwValidationError(null, 'Missing txids ' + failedTransactions.join(', '));
      }

      var failedBlocks = blockidGroups[group].filter(function(blockid) { return !blockByIdGroups[group][blockid]; });
      if (failedBlocks.length > 0) {
        throwValidationError(null, 'Missing blocks ' + failedBlocks.join(', '));
      }
    });

    outputs.forEach(function(o) {
      var group = outputGroup(o);
      var txoutStr = [o.txid, o.vout].join(':');
      var tx = txByIdGroups[group][o.txid];

      // If we don't have the tx, just return. We checked existence above.
      if (!tx) {
        if (group >= minGroupToValidate) {
          console.dir(o);
          throw new Error('Uh oh - missing txid ' + o.txid + ' but no previous error. Group = ' + group);
        }
        return;
      }
      var txout = tx.outs[o.vout];

      // validate amount
      if (o.satoshis !== txout.value) {
        throwValidationError(o, 'Amount mismatch', o.satoshis, txout.value);
      }

      // validate address
      var address = bitcoin.address.fromOutputScript(txout.script, bitcoin.getNetwork());
      if (o.address !== address) {
        throwValidationError(o, 'Address mismatch', o.address, address);
      }

      // validate it's in the right block, and confirms matches
      if (o.blockhash || o.confirmations) {
        if (!o.blockhash) {
          throwValidationError(o, 'Has non-zero confirms but missing blockhash');
        }
        if (!o.confirmations) {
          throwValidationError(o, 'Has blockhash but missing confirms');
        }
        block = blockByIdGroups[group][o.blockhash];

        // If we're missing block, just return.
        if (!block) {
          assert(group < minGroupToValidate);
          return;
        }

        // validate tx included in block
        if (block.tx.indexOf(o.txid) === -1) {
          throwValidationError(o, 'Not included in block ' + block.hash);
        }

        // validate height matches
        if (block.height !== o.height) {
          throwValidationError(o, 'Height mismatch', o.height, block.height);
        }

        // validate confirms match. We allow us to under-report confirms by up to 2, but only
        // be ahead by up to 1.
        var confirmDifference = o.confirmations - block.confirmations;
        if (confirmDifference < -2) {
          throwValidationError(o, 'Confirms too low', o.confirmations, block.confirmations);
        }
        if (confirmDifference > 1) {
          throwValidationError(o, 'Confirms too high', o.confirmations, block.confirmations);
        }
      }
    });

    return outputs;
  });
};

/**
 * Returns up to 'count' most recent transactions skipping the first 'from' transactions for account 'account'
 * @param account The user's HD wallet
 * @param count The number of transactions to return
 * @param from The number of transactions to skip
 * @param minHeight Only return transactions from a block with minHeight and above
 * @param decryptTravelInfo  Decrypt received travel info if it exists
 * @param minConfirms Only return transactions with at least this many confirmations
 * @param maxHeight Only return transactions from a block with maxHeight and below
 * @returns {*}
 */
BitGoD.prototype.handleListTransactions = function(account, count, from, minHeight, decryptTravelInfo, minConfirms, maxHeight) {
  this.ensureWallet();
  var self = this;

  this.ensureBlankAccount(account);
  count = this.getInteger(count, 10);
  from = this.getInteger(from, 0);

  if (count < 0) {
    throw this.error('Negative count', -8);
  }
  if (from < 0) {
    throw this.error('Negative from', -8);
  }

  minHeight = this.getNumber(minHeight, 0);
  minConfirms = this.getNumber(minConfirms, 0);
  maxHeight = this.getNumber(maxHeight, 999999999);

  var keychain = decryptTravelInfo ? this.getSigningKeychain() : undefined;

  var outputList = [];
  var getTransactionsInternal = function(skip) {
    return self.wallet.transactions({ limit: 500, skip: skip, minHeight: minHeight, minConfirms: minConfirms, maxHeight: maxHeight })
    .then(function(res) {
      res.transactions.every(function(tx) {
        self.processTxAndAddOutputsToList(tx, outputList, keychain);
        return (outputList.length < count + from);
      });

      if (outputList.length >= count + from || // we have enough transactions collected in the output list
          (res.start + res.count) >= res.total || // we have received all of the transactions available on the server
          res.count <= 0) { // there are no more results
        return;
      } else {
        return getTransactionsInternal(skip + res.count);
      }
    });
  };

  return getTransactionsInternal(0)
  .then(function() {
    return outputList
    .slice(from, count + from)
    .sort(function(a, b) {
      if (b.confirmations != a.confirmations) {
        return b.confirmations - a.confirmations;
      }
      if (b.amount != a.amount) {
        return b.amount - a.amount;
      }
      if (b.address !== a.address) {
        return (b.address > a.address) ? 1 : -1;
      }
      return (b.txid > a.txid ? 1 : -1);
    });
  })
  .then(function(outputs) {
    if (!self.validate) {
      return outputs;
    }
    return self.validateTxOutputs(outputs);
  });
};

BitGoD.prototype.handleListSinceBlock = function(blockHash, targetConfirms) {
  this.ensureWallet();
  var self = this;

  // targetConfirms seems like just another way to do GetBlockHash and doesn't affect transactions
  if (targetConfirms && targetConfirms != 1) {
    throw new Error('targetConfirms not supported');
  }

  var transactions;

  return Q()
  .then(function() {
    // If a block hash was provided, find it's height. If no hash provided, then get all transactions from height of 0
    if (blockHash) {
      return self.bitgo.blockchain().getBlock({ id: blockHash})
      .then(function(block) {
        if (!block) {
          throw this.error('Invalid block hash', -5);
        }
        return block.height;
      });
    }
    return 0;
  })
  .then(function(height) {
    // listsinceblock will return ALL transactions with no limit
    return self.handleListTransactions("", 1e12, 0, height || undefined);
  })
  .then(function(result) {
    transactions = result.reverse();
    // Get latest block hash
    return self.bitgo.blockchain().getBlock({ id: 'latest' });
  })
  .then(function(block) {
    return {
      transactions: transactions,
      lastblock: block.id
    };
  });
};

BitGoD.prototype.handleGetReceivedByAddress = function(address, minConfirms) {
  this.ensureWallet();
  var self = this;

  if (!address) {
    throw this.error('No address provided', -1);
  }
  if (!this.bitgo.verifyAddress({ address: address })) {
    throw this.error('Invalid Bitcoin address', -5);
  }
  minConfirms = this.getNumber(minConfirms, 1);
  var totalReceived = 0;

  var getTransactionsInternal = function(skip) {
    // TODO: use SDK func once it supports paging
    var limit = 500;
    var url = self.bitgo.url("/address/" + address + '/tx?limit=' + limit + '&skip=' + skip);
    return self.bitgo.get(url)
    .result()
    .then(function(res) {
      res.transactions.forEach(function(tx) {
        if (tx.confirmations >= minConfirms) {
          tx.outputs.forEach(function(output) {
            if (output.account === address) {
              totalReceived += output.value;
            }
          });
        }
      });

      if (res.count < limit) {
        return;
      }
      return getTransactionsInternal(skip + res.count);
    });
  };

  return getTransactionsInternal(0)
  .then(function() {
    return self.toBTC(totalReceived);
  });
};

BitGoD.prototype.handleGetTransaction = function(txid, decryptTravelInfo) {
  this.ensureWallet();
  var self = this;

  var outputList = [];
  var tx;

  return self.wallet.getTransaction({ id: txid })
  .then(function(res) {
    tx = res;
    var keychain = decryptTravelInfo ? self.getSigningKeychain() : undefined;
    return self.processTxAndAddOutputsToList(tx, outputList, keychain);
  })
  .then(function(outputs) {
    if (!self.validate) {
      return outputs;
    }
    return self.validateTxOutputs(outputs);
  })
  .then(function(outputs) {

    var result = {
      amount: tx.amount,
      confirmations: tx.confirmations,
      blockhash: tx.blockhash,
      // blockindex: 0,  // don't have it
      // blocktime: '',  // don't have it
      txid: tx.id,
      time: new Date(tx.date).getTime() / 1000,
      timereceived: new Date(tx.date).getTime() / 1000,
      hex: tx.hex,
      instant: tx.instant,
      instantId: tx.instantId,
      receivedTravelInfo: tx.receivedTravelInfo,
      sentTravelInfo: tx.sentTravelInfo
    };

    result.details = [];
    outputList.forEach(function(output) {
      result.details.push({
        account: self.masqueradeAccount,
        address: output.address,
        category: output.category,
        amount: output.amount,
        vout: output.vout
      });
    });

    if (tx.netValue < 0) {
      result.fee = self.toBTC(-tx.fee);
    }

    return result;
  })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

BitGoD.prototype.handleGetTransactionBySequenceId = function(sequenceId) {
  var self = this;
  this.ensureWallet();

  return this.wallet.getWalletTransactionBySequenceId({ sequenceId: sequenceId })
  .then(function(wallettx) {
    return wallettx.transaction;
  })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

BitGoD.prototype.handleGetRecipients = function(txid) {
  var self = this;

  return this.bitgo.travelRule().getRecipients({ txid: txid })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

BitGoD.prototype.handleSendTravelInfo = function(txid, travelInfos) {
  if (typeof(travelInfos) === 'string') {
    travelInfos = JSON.parse(travelInfos);
  }
  var self = this;

  return this.bitgo.travelRule().sendMany({ txid: txid, travelInfos: travelInfos })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

BitGoD.prototype.handleSetTxFee = function(btcAmount) {
  this.ensureWallet();
  this.txFeeRate = Math.round(Number(btcAmount) * 1e8);
  this.txConfirmTarget = undefined;
  return true;
};

BitGoD.prototype.handleSetTxConfirmTarget = function(numBlocks) {
  this.ensureWallet();
  this.txFeeRate = undefined;
  this.txConfirmTarget = numBlocks;
  return true;
};

BitGoD.prototype.handleEstimateFee = function(numBlocks) {
  var self = this;
  return this.bitgo.estimateFee({ numBlocks: numBlocks })
  .then(function(result) {
    return self.toBTC(result.feePerKb);
  });
};

BitGoD.prototype.handleGetInstantGuarantee = function(id) {
  var self = this;
  return this.bitgo.instantGuarantee({ id: id })
  .then(function(result) {
    result.amount = self.toBTC(result.amount);
    return result;
  });
};

BitGoD.prototype.handleConsolidateUnspents = function(target, maxIterationCount){
  this.ensureWallet();
  target = this.getNumber(target);
  maxIterationCount = this.getNumber(maxIterationCount);
  return this.wallet.consolidateUnspents({
    target: target,
    maxIterationCount: maxIterationCount,
    walletPassphrase: this.passphrase
  });
};

BitGoD.prototype.handleFanOutUnspents = function(target){
  this.ensureWallet();
  target = this.getNumber(target);
  return this.wallet.fanOutUnspents({
    target: target,
    walletPassphrase: this.passphrase
  });
};

BitGoD.prototype.handleSendToAddress = function(address, btcAmount, comment, commentTo, instant, sequenceId, minUnspentSize) {
  this.ensureWallet();
  var self = this;
  var satoshis = Math.round(Number(btcAmount) * 1e8);

  if (instant && typeof(instant) !== 'boolean') {
    throw self.error('Instant flag was not a boolean', -1);
  }

  return this.getWallet()
  .then(function(wallet) {
    self.wallet = wallet;
    var recipients = {};
    recipients[address] = satoshis;

    return self.wallet.createTransaction({
      minConfirms: 1,
      recipients: recipients,
      feeRate: self.txFeeRate,
      feeTxConfirmTarget: self.txConfirmTarget,
      instant: !!instant,
      targetWalletUnspents: self.minUnspentsTarget,
      minUnspentSize: minUnspentSize
    });
  })
  .then(function(result) {
    result.keychain = self.getSigningKeychain();
    return self.wallet.signTransaction(result);
  })
  .then(function(tx) {
    return self.wallet.sendTransaction({
      tx: tx.tx,
      message: comment,
      instant: !!instant,
      sequenceId: sequenceId
    });
  })
  .then(function(result) {
    if (result.status !== 'accepted') {
      result.message = result.error;
      throw result;
    }
    return result.hash;
  })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

/**
 * Send many (with extended result)
 */
BitGoD.prototype.handleSendManyExtended = function(account, recipients, minConfirms, comment, instant, sequenceId, minUnspentSize, enforceMinConfirmsForChange) {
  if (typeof(recipients) === 'string') {
    recipients = JSON.parse(recipients);
  }
  this.ensureWallet();
  var self = this;
  this.ensureBlankAccount(account);
  minConfirms = this.getNumber(minConfirms, 1);
  minUnspentSize = this.getNumber(minUnspentSize);

  if (_.isString(enforceMinConfirmsForChange)) {
    enforceMinConfirmsForChange = enforceMinConfirmsForChange === 'true' ? true : false;
  }
  if (!_.isUndefined(enforceMinConfirmsForChange) && !_.isBoolean(enforceMinConfirmsForChange)) {
    throw self.error('enforceMinConfirmsForChange flag was not a boolean, please pass true or false', -1);
  }

  if (_.isString(instant)) {
    instant = instant === 'true' ? true : false;
  }
  if (!_.isUndefined(instant) && !_.isBoolean(instant)) {
    throw self.error('instant flag was not a boolean, please pass true or false', -1);
  }

  if (recipients instanceof Array) {
    recipients.forEach(function(recipient) {
      if (!recipient.address || !recipient.amount) {
        throw self.error('Incorrect sendmany input - address ' + recipient.address + ', amount ' + recipient.amount, -1);
      }
      recipient.amount = Math.round(Number(recipient.amount) * 1e8);
    });
  } else {
    Object.keys(recipients).forEach(function (destinationAddress) {
      recipients[destinationAddress] = Math.round(Number(recipients[destinationAddress]) * 1e8);
    });
  }

  return this.getWallet()
  .then(function(wallet) {
    return self.wallet.sendMany({
      minConfirms: minConfirms,
      enforceMinConfirmsForChange: !!enforceMinConfirmsForChange,
      recipients: recipients,
      feeRate: self.txFeeRate,
      feeTxConfirmTarget: self.txConfirmTarget,
      instant: !!instant,
      minUnspentSize: minUnspentSize,
      targetWalletUnspents: self.minUnspentsTarget,
      keychain: self.getSigningKeychain(),
      sequenceId: sequenceId
    });
  })
  .then(function(result) {
    if (result.status !== 'accepted') {
      result.message = result.error;
      throw result;
    }
    return result;
  })
  .catch(function(err) {
    throw self.modifyError(err);
  });
};

BitGoD.prototype.handleSendMany = function(account, recipients, minConfirms, comment, instant, sequenceId, minUnspentSize, enforceMinConfirmsForChange) {
  // Call sendManyExtended internally, but return just the txid, to conform to sendmany specification
  return this.handleSendManyExtended(account, recipients, minConfirms, comment, instant, sequenceId, minUnspentSize, enforceMinConfirmsForChange)
  .then(function(result) {
    return result.hash;
  });
};

BitGoD.prototype.handleSendFrom = function(account, address, amount, minConfirms, comment) {
  var recipients = {};
  recipients[address] = amount;
  return this.handleSendMany(account, recipients, minConfirms, comment);
};

BitGoD.prototype.handleGetWalletInfo = function() {
  var self = this;
  this.ensureWallet();

  return this.getWallet()
  .then(function(wallet) {
    return {
      walletversion: 'bitgo',
      balance: self.toBTC(wallet.confirmedBalance()),
      unconfirmedbalance: self.toBTC(wallet.balance() - wallet.confirmedBalance()),
      cansendinstant: wallet.canSendInstant()
      //unlocked_until: wallet.wallet.unlock
    };
  });
};

BitGoD.prototype.handleGetInfo = function() {
  var self = this;
  var promises = [];
  var hasToken = !!this.bitgo._token;

  // Show the effective tx confirm target, which defaults to 2 if txFeeRate is not set
  var effectiveTxConfirmTarget = self.txConfirmTarget;
  if (typeof(self.txConfirmTarget) === 'undefined' && typeof(self.txFeeRate) === 'undefined') {
    effectiveTxConfirmTarget = 2;
  }

  promises.push(self.client ? self.callLocalMethod('getinfo', []) : undefined);
  promises.push(hasToken ? self.getBalance(1) : undefined);
  if (typeof(effectiveTxConfirmTarget) !== 'undefined') {
    promises.push(self.handleEstimateFee(effectiveTxConfirmTarget));
  }

  var unlockedUntil = 0;
  if (self.passphrase && self.passPhraseExpires > new Date()) {
    unlockedUntil = Math.floor(self.passPhraseExpires.getTime() / 1000);
  } else if (self.keychain && self.keychain.xprv) {
    unlockedUntil = 9999999999;
  }

  return Q.all(promises)
  .spread(function(proxyInfo, balance, dynamicFee) {
    var info = {
      bitgod: true,
      version: BITGOD_VERSION,
      testnet: bitgo.getNetwork() === 'testnet',
      token: hasToken,
      wallet: self.wallet ? self.wallet.id() : false,
      keychain: !!self.keychain,
      balance: balance,
      paytxfee: typeof(self.txFeeRate) !== 'undefined' ? self.toBTC(self.txFeeRate) : dynamicFee,
      txconfirmtarget: typeof(effectiveTxConfirmTarget) !== 'undefined' ? effectiveTxConfirmTarget : -1,
      unlocked_until: unlockedUntil
    };
    if (proxyInfo) {
      // Strip irrelevant fields, since wallet functionality is not used
      info.proxy = _.omit(proxyInfo, ['balance', 'walletversion', 'keypoololdest', 'keypoolsize', 'paytxfee']);
    }
    return info;
  });
};

BitGoD.prototype.handleNotImplemented = function() {
  throw this.error('Not implemented', -32601);
};

BitGoD.prototype.handleHelp = function(command) {
  var self = this;
  if (command) {
    if (this.help[command]) {
      return this.help[command];
    }
    if (this.client) {
      return this.callLocalMethod('help', [command]);
    }
    return 'help: unknown command: ' + command;
  }

  // Global help
  return Q().then(function() {
    if (self.client) {
      return self.callLocalMethod('help', []);
    }
  })
  .then(function(proxyHelp) {
    proxyHelp = proxyHelp || '';
    if (proxyHelp) {
      var walletStart = proxyHelp.indexOf('== Wallet ==');
      if (walletStart > 0) {
        proxyHelp = proxyHelp.substr(0, walletStart);
      }
      var lines = proxyHelp.split('\n');
      lines = lines.filter(function(line) {
        var words = line.split(' ');
        return (!words.length || !self.help[words[0]]);
      });
      proxyHelp = lines.join('\n');
      proxyHelp = '*** START BITCOIND PROXIED COMMANDS *** \n\n' + proxyHelp + '*** END BITCOIND PROXIED COMMANDS ***\n\n';
    }
    return proxyHelp + self.help.bitgod;
  });
};

/**
 * Expose an RPC method
 * @param   {String} name   the method name
 * @param   {Function} method   the @method
 */
BitGoD.prototype.expose = function(name, method, noLogArgs) {
  var self = this;
  this.server.expose(name, function(args, opt, callback) {
    var argString = noLogArgs ? '' : (' ' + JSON.stringify(args));
    self.log('RPC call: ' + name, argString);
    return Q().then(function() {
      return method.apply(self, args);
    })
    .catch(function(err) {
      self.logError(err.stack);
      throw err;
    })
    .nodeify(callback);
  });
};

BitGoD.prototype.run = function(testArgString) {

  // Defaults (get overridden by conf file, or command line args)
  var config = {
    proxyhost: 'localhost',
    proxyuser: 'bitcoinrpc',
    rpcbind: 'localhost',
    env: 'test'
  };

  // Parse command line args
  var args = this.getArgs(testArgString && testArgString.split(' '));

  // Get config (config file location depends on command line arg -conf)
  var parsedConfig = this.getConfig(args.conf);

  // Conf file overrides default options
  _.assign(config, parsedConfig);

  // Command-line args override config file options
  _.keys(args).forEach(function(k) {
    // parseArgs annoyingly sets missing values to null
    if (args[k] !== null) {
      config[k] = args[k];
    }
  });

  var self = this;
  var userAgent = "BitGoD/" + BITGOD_VERSION;

  // Instantiate BitGo
  this.bitgo = new bitgo.BitGo({ env: config.env, userAgent: userAgent });

  var serverOptions = {
    'websocket': true,
    'headers': {
      'Access-Control-Allow-Origin': '*'
    }
  };

  if (config.rpcssl) {
    if (!config.rpcsslkey || !config.rpcsslcert) {
      throw new Error('rpcssl specified without rpcsslkey and rpcsslcert');
    }
    serverOptions.https = { keyPath: config.rpcsslkey, certPath: config.rpcsslcert };
    serverOptions.type = 'https';
  }

  // Set up RPC server
  this.server = rpc.Server.$create(serverOptions);

  // Basic Auth
  if (!!config.rpcuser !== !!config.rpcpassword) {
    throw new Error('rpcuser specified without rpcpassword or vice versa');
  }
  if (config.rpcuser) {
    this.server.enableAuth(config.rpcuser, config.rpcpassword);
    this.log('Basic Auth enabled for user ' + config.rpcuser);
  }

  // Validation vs bitcoind
  if (config.validate) {
    if (config.validate !== 'loose' && config.validate !== 'strict') {
      throw new Error('unknown validation mode - supported modes are loose and strict');
    }
    if (!config.proxy) {
      throw new Error('validate option requires a proxy bitcoind');
    }
    this.validate = config.validate;
    this.log('Validating in ' + this.validate + ' mode');
  }

  self.masqueradeAccount = config.masqueradeaccount;

  self.minUnspentsTarget = 20; // Good initial default for a bitgod wallet
  if (config.minunspentstarget) {
    var parsedMinUnspentsTarget = parseInt(config.minunspentstarget);
    if (parsedMinUnspentsTarget === NaN) {
      throw new Error('minunspentstarget option must be a number');
    }
    self.minUnspentsTarget = parsedMinUnspentsTarget;
  }

  if (config.logfile) {
    self.logger.add(winston.transports.File, { level: 'info', filename: config.logfile, timestamp: true, colorize: false, json: false });
  }

  // Read in help
  self.help = {};
  try {
    var helpFiles = fs.readdirSync(__dirname + '/help');
    helpFiles.forEach(function(fileName) {
      self.help[fileName] = fs.readFileSync(__dirname + '/help/' + fileName, 'utf8');
    });
  } catch (err) {
    console.error('Failed loading help files: '+ err.message);
  }

  self.notImplemented = [];

  // Will not implement
  var willNotImplement = 'addmultisigaddress backupwallet dumpprivkey dumpwallet getaccount getaccountaddress importaddress importprivkey importwallet keypoolrefill listaddressgroupings listlockunspent listreceivedbyaccount lockunspent move setaccount signmessage';
  willNotImplement.split(' ').forEach(function(api) {
    self.notImplemented.push(api);
    self.expose(api, self.handleNotImplemented);
  });

  // Just not implemented yet
  var notImplemented = 'encryptwallet getreceivedbyaccount';
  notImplemented.split(' ').forEach(function(api) {
    self.notImplemented.push(api);
    self.expose(api, self.handleNotImplemented);
  });

  //BitGo-handled bitcoind methods
  self.traditionalBitcoindMethods = {
    'getnewaddress' : self.handleGetNewAddress,
    'getrawchangeaddress' : self.handleGetRawChangeAddress,
    'getbalance' : self.handleGetBalance,
    // FIXME BG-2862: `getinfo` is deprecated
    'getinfo' : self.handleGetInfo,
    'getwalletinfo' : self.handleGetWalletInfo,
    'getunconfirmedbalance' : self.handleGetUnconfirmedBalance,
    'gettransaction' : self.handleGetTransaction,
    'listaccounts' : self.handleListAccounts,
    'listunspent' : self.handleListUnspent,
    'sendtoaddress' : self.handleSendToAddress,
    'sendfrom' : self.handleSendFrom,
    'listtransactions' : self.handleListTransactions,
    'listsinceblock' : self.handleListSinceBlock,
    'getreceivedbyaddress' : self.handleGetReceivedByAddress,
    'sendmany' : self.handleSendMany,
    'settxfee' : self.handleSetTxFee,
    'validateaddress' : self.handleValidateAddress,
    'walletpassphrase' : self.handleWalletPassphrase,
    'walletlock' : self.handleWalletLock,
    'estimatefee' : self.handleEstimateFee,
    'getaddressesbyaccount' : self.handleGetAddressesByAccount,
    'help' : self.handleHelp
  };

  // BitGo-specific methods
  self.bitgoSpecificMethods = {
    'settoken' : self.handleSetToken,
    'setkeychain' : self.handleSetKeychain,
    'setwallet' : self.handleSetWallet,
    'session' : self.handleSession,
    'unlock' : self.handleUnlock,
    'lock' : self.handleLock,
    'freezewallet' : self.handleFreezeWallet,
    'settxconfirmtarget' : self.handleSetTxConfirmTarget,
    'getinstantguarantee' : self.handleGetInstantGuarantee,
    'consolidateunspents' : self.handleConsolidateUnspents,
    'fanoutunspents': self.handleFanOutUnspents,
    'gettransactionbysequenceid' : self.handleGetTransactionBySequenceId,
    'getrecipients': self.handleGetRecipients,
    'sendtravelinfo': self.handleSendTravelInfo,
    'sendmanyextended': self.handleSendManyExtended
  };

  self.noLogArgsMethods = ['walletpassphrase', 'settoken', 'setkeychain'];

  var exposeMethods = function(value, key) {
    self.expose(key, value, _.contains(self.noLogArgsMethods, key));
  };

  _.forEach(self.traditionalBitcoindMethods, exposeMethods);
  _.forEach(self.bitgoSpecificMethods, exposeMethods);

  return Q().then(function() {
    // Proxy bitcoind
    if (config.proxy) {
      return self.setupProxy(config);
    }
  })
  .then(function() {
    // Listen
    var port = config.rpcport || (bitgo.getNetwork() === 'bitcoin' ? 9332 : 19332);
    self.httpServer = self.server.listen(port, config.rpcbind);
    self.log('JSON-RPC server active on ' + config.rpcbind + ':' + port);
  })
  .catch(function(err) {
    self.logError(err.message);
    // self.log(err.stack);
  })
  .done();
};

BitGoD.prototype.stop = function(callback) {
  this.httpServer.close(callback);
  console.info("JSON-RPC server stopped");
}

exports = module.exports = BitGoD;
