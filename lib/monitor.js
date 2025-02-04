var fs = require('fs'),
  path = require('path'),
  _ = require('lodash'),
  chalk = require('chalk'),
  ansiHTML = require('ansi-html'),
  totalmem = require('os').totalmem(),
  pidusage = require('pidusage'),
  url = require('url'),
  socketIOClient = require('socket.io-client'),
  pm = require('./pm'),
  stat = require('./stat'),
  conf = require('./util/conf'),
  Log = require('./util/log'),
  defConf;

module.exports = Monitor;

/**
 * Monitor of project monitor web.
 * @param options
 * @returns {Monitor}
 * @constructor
 */
function Monitor(options) {
  if (!(this instanceof Monitor)) {
    return new Monitor(options);
  }

  // Initialize...
  this._init(options);
};

Monitor.ACCEPT_KEYS = ['pm2', 'refresh', 'daemonize', 'max_restarts', 'port', 'log', 'agent', 'remotes', 'origins'];
Monitor.DEF_CONF_FILE = 'pm2-gui.ini';
Monitor.PM2_DAEMON_PROPS = ['DAEMON_RPC_PORT', 'DAEMON_PUB_PORT'];

/**
 * Run socket.io server.
 */
Monitor.prototype.run = function () {
  this._noClient = true;

  this._tails = {};
  this._usages = {};

  // Observe PM2
  this._observePM2();

  this._listeningSocketIO();
};

/**
 * Quit monitor.
 * @return {[type]} [description]
 */
Monitor.prototype.quit = function () {
  if (this.pm2Sock) {
    console.debug('Closing pm2 pub emitter socket.');
    this.pm2Sock.close();
  }
  if (this._sockio) {
    console.debug('Closing socket.io server.');
    this._sockio.close();

    console.debug('Destroying tails.');
    this._killTailProcess();
  }
};

/**
 * Connect to socket.io server.
 * @param  {String} ns the namespace.
 * @param  {Function} success 
 * @param  {Function} failure 
 */
Monitor.prototype.connect = function (options, success, failure) {
  if (!options.port) {
    throw new Error('Port is required!');
  }
  var auth,
    serverUri = Monitor.toConnectionString(options);

  console.info('Connecting to', serverUri);
  var socket = socketIOClient(serverUri);
  socket.on('connect', function () {
    !success._called && success(socket);
    success._called = true;
  });

  socket.on('error', function (err) {
    !failure._called && failure(err, socket);
    failure._called = true;
  });

  socket.on('connect_error', function (err) {
    !failure._called && failure(err, socket);
    failure._called = true;
  });
};

/**
 * Resolve home path.
 * @param {String} pm2Home
 * @returns {*}
 * @private
 */
Monitor.prototype._resolveHome = function (pm2Home) {
  if (pm2Home && pm2Home.indexOf('~/') == 0) {
    // Get root directory of PM2.
    pm2Home = process.env.PM2_HOME || path.resolve(process.env.HOME || process.env.HOMEPATH, pm2Home.substr(2));

    // Make sure exist.
    if (!pm2Home || !fs.existsSync(pm2Home)) {
      throw new Error('PM2 root can not be located, try to initialize PM2 by executing `pm2 ls` or set environment variable vi `export PM2_HOME=[ROOT]`.');
    }
  }
  return pm2Home;
};

/**
 * Initialize options and configurations.
 * @private
 */
Monitor.prototype._init = function (options) {
  options = options || {};

  defConf = conf.File(options.confFile || path.resolve(__dirname, '..', Monitor.DEF_CONF_FILE)).loadSync().valueOf();
  defConf = _.pick.call(null, defConf, Monitor.ACCEPT_KEYS);

  options = _.pick.apply(options, Monitor.ACCEPT_KEYS).valueOf();
  options = _.defaults(options, defConf);

  options.pm2 = this._resolveHome(options.pm2);
  Log(options.log);

  // Load PM2 config.
  var pm2ConfPath = path.join(options.pm2, 'conf.js'),
    fbMsg = '';
  try {
    options.pm2Conf = require(pm2ConfPath)(options.pm2);
    if (!options.pm2Conf) {
      throw new Error(404);
    }
  } catch (err) {
    fbMsg = 'Can not load PM2 config, the file "' + pm2ConfPath + '" does not exist or empty, fallback to auto-load by pm2 home. ';
    console.warn(fbMsg);
    options.pm2Conf = {
      DAEMON_RPC_PORT: path.resolve(options.pm2, 'rpc.sock'),
      DAEMON_PUB_PORT: path.resolve(options.pm2, 'pub.sock'),
      PM2_LOG_FILE_PATH: path.resolve(options.pm2, 'pm2.log')
    };
  }

  Monitor.PM2_DAEMON_PROPS.forEach(function (prop) {
    var val = options.pm2Conf[prop];
    if (!val || !fs.existsSync(val)) {
      throw new Error(fbMsg + 'Unfortunately ' + (val || prop) + ' can not found, please makesure that your pm2 is running and the home path is correct.');
    }
  });

  // Bind socket.io server to context.
  if (options.sockio) {
    this.sockio = options.sockio;
    delete options.sockio;
  }

  // Bind to context.
  this.options = options;
  Object.freeze(this.options);
};

/**
 * Connection event of `sys` namespace.
 * @param {Socket} socket
 * @private
 */
Monitor.prototype._connectSysSock = function (socket) {
  var self = this;
  // Still has one client connects to server at least.
  self._noClient = false;

  socket.on('disconnect', function () {
    // Check connecting client.
    self._noClient = self._sockio.of(conf.NSP.SYS).sockets.length == 0;
  });

  // Trigger actions of process.
  socket.on('action', function (action, id) {
    console.debug('[pm2:' + id + ']', action, 'sending to pm2 daemon...');
    pm.action(self.options.pm2Conf.DAEMON_RPC_PORT, action, id, function (err, forceRefresh) {
      if (err) {
        console.error(action, err.message);
        return socket.emit('action', id, err.message);
      }
      console.debug('[pm2:' + id + ']', action, 'completed!');
      forceRefresh && self._throttleRefresh();
    });
  });
  sendProcs();
  socket.on('procs', sendProcs);
  self._pm2Ver(socket);
  this._sysStat && this._broadcast('system_stat', this._sysStat);

  // Grep system states once and again.
  (this._status != 'R') && this._nextTick(this.options.refresh || 5000);

  function sendProcs() {
    self._procs && socket.emit(typeof self._procs == 'string' ? 'info' : 'procs', self._procs);
  }
};

/**
 * Connection event of `log` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectLogSock = function (socket) {
  var self = this;

  // Emit error.
  function emitError(err, pm_id, keepANSI) {
    var data = {
      pm_id: pm_id,
      msg: keepANSI ? chalk.red(err.message) : '<span style="color: #ff0000">Error: ' + err.message + '</span>'
    };
    self._broadcast.call(self, 'log', data, conf.NSP.LOG);
  }

  function startTailProcess(pm_id, keepANSI) {
    socket._pm_id = pm_id;

    if (self._tails[pm_id]) {
      return;
    }

    // Tail logs.
    pm.tail({
      sockPath: self.options.pm2Conf.DAEMON_RPC_PORT,
      logPath: self.options.pm2Conf.PM2_LOG_FILE_PATH,
      pm_id: pm_id
    }, function (err, lines) {
      if (err) {
        return emitError(err, pm_id, keepANSI);
      }
      // Emit logs to clients.
      var data = {
        pm_id: pm_id,
        msg: lines.map(function (line) {
          if (!keepANSI) {
            line = line.replace(/\s/, '&nbsp;');
            return '<span>' + ansiHTML(line) + '</span>';
          } else {
            return line;
          }
        }).join(keepANSI ? '\n' : '')
      };
      self._broadcast.call(self, 'log', data, conf.NSP.LOG);
    }, function (err, tail) {
      if (err) {
        return emitError(err, pm_id, keepANSI);
      }
      if (!tail) {
        return emitError(new Error('No log can be found.'), pm_id, keepANSI);
      }

      console.info('[pm2:' + pm_id + ']', 'tail starting...');
      self._tails[pm_id] = tail;
    });
  }

  socket.on('disconnect', self._killTailProcess.bind(self));
  socket.on('tail_kill', self._killTailProcess.bind(self));
  socket.on('tail', startTailProcess);
  console.info('Connected to ' + socket.nsp.name + '!');
};

/**
 * Connection event of `proc` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectProcSock = function (socket) {
  var self = this;
  // Emit error.
  function emitError(err, pid) {
    var data = {
      pid: pid,
      msg: '<span style="color: #ff0000">Error: ' + err.message + '</span>'
    };
    self._broadcast.call(self, 'proc', data, conf.NSP.PROC);
  }

  function killObserver() {
    var socks = self._sockio.of(conf.NSP.PROC).sockets,
      canNotBeDeleted = {};

    if (Array.isArray(socks) && socks.length > 0) {
      socks.forEach(function (sock) {
        canNotBeDeleted[sock.pid.toString()] = 1;
      });
    }

    for (var pid in self._usages) {
      var timer;
      if (!canNotBeDeleted[pid] && (timer = self._usages[pid])) {
        clearInterval(timer);
        delete self._usages[pid];
        console.debug('[pid:' + pid + ']', 'cpu and memory observer destroyed!');
      }
    }
  }

  function runObserver(pid) {
    socket._pid = pid;

    var pidStr = pid.toString();
    if (self._usages[pidStr]) {
      return;
    }

    console.debug('[pid:' + pidStr + ']', 'cpu and memory observer is running...');

    function runTimer() {
      pidusage.stat(pid, function (err, stat) {
        if (err) {
          clearInterval(ctx._usages[pidStr]);
          delete ctx._usages[pidStr];
          return emitError.call(self, err, pid);
        }
        stat.memory = stat.memory * 100 / totalmem;

        var data = {
          pid: pid,
          time: Date.now(),
          usage: stat
        };
        self._broadcast.call(self, 'proc', data, conf.NSP.PROC);
      });
    }

    self._usages[pidStr] = setInterval(runTimer, 3000);
    runTimer(this);
  }

  socket.on('disconnect', killObserver);
  socket.on('proc', runObserver);
  console.info('Connected to ' + socket.nsp.name + '!');
};

/**
 * Grep system state loop
 * @param {Number} tick
 * @private
 */
Monitor.prototype._nextTick = function (tick, continuously) {
  // Return it if worker is running.
  if (this._status == 'R' && !continuously) {
    return;
  }
  // Running
  this._status = 'R';
  console.debug('monitor heartbeat per', tick + 'ms');
  // Grep system state
  this._systemStat(function () {
    // If there still has any client, grep again after `tick` ms.
    if (!this._noClient) {
      return setTimeout(this._nextTick.bind(this, tick, true), tick);
    }
    // Stop
    delete this._status;
    console.debug('monitor heartbeat destroyed!');
  });
};

/**
 * Grep system states.
 * @param {Function} cb
 * @private
 */
Monitor.prototype._systemStat = function (cb) {
  stat.cpuUsage(function (err, cpu_usage) {
    if (err) {
      // Log only.
      console.error('Can not load system/cpu/memory information: ', err.message);
    } else {
      // System states.
      this._sysStat = _.defaults(_(stat).pick('cpus', 'arch', 'hostname', 'platform', 'release', 'uptime', 'memory').clone(), {
        cpu: cpu_usage
      });
      this._broadcast.call(this, 'system_stat', this._sysStat);
    }
    cb.call(this);
  }, this);
};

/**
 * Observe PM2
 * @private
 */
Monitor.prototype._observePM2 = function () {
  var pm2Daemon = this.options.pm2Conf.DAEMON_PUB_PORT;
  console.info('Connecting to pm2 daemon:', pm2Daemon);
  this.pm2Sock = pm.sub(pm2Daemon, function (data) {
    console.info(chalk.magenta(data.event), data.process.name + '-' + data.process.pm_id);
    this._throttleRefresh();
  }, this);

  // Enforce a refresh operation if RPC is not online.
  this._throttleRefresh();
};

/**
 * Throttle the refresh behavior to avoid refresh bomb
 * @private
 */
Monitor.prototype._throttleRefresh = function () {
  if (this._throttle) {
    clearTimeout(this._throttle);
  }
  this._throttle = setTimeout(function (ctx) {
    ctx._throttle = null;
    ctx._refreshProcs();
  }, 500, this);
};

/**
 * Refresh processes
 * @private
 */
Monitor.prototype._refreshProcs = function () {
  pm.list(this.options.pm2Conf.DAEMON_RPC_PORT, function (err, procs) {
    if (err) {
      return this._broadcast('info', 'Can not connect to pm2 daemon, ' + err.message);
    }
    // Wrap processes and cache them.
    this._procs = procs.map(function (proc) {
      proc.pm2_env = proc.pm2_env || {
        USER: 'UNKNOWN'
      };
      var pm2_env = {
        user: proc.pm2_env.USER
      };

      for (var key in proc.pm2_env) {
        // Ignore useless fields.
        if (key.slice(0, 1) == '_' ||
          key.indexOf('axm_') == 0 || !!~['versioning', 'command'].indexOf(key) ||
          key.charCodeAt(0) <= 90) {
          continue;
        }
        pm2_env[key] = proc.pm2_env[key];
      }
      proc.pm2_env = pm2_env;
      return proc;
    });
    // Emit to client.
    this._broadcast('procs', this._procs);
  }, this)
};

/**
 * Get PM2 version and return it to client.
 * @private
 */
Monitor.prototype._pm2Ver = function (socket) {
  var pm2RPC = this.options.pm2Conf.DAEMON_RPC_PORT;
  console.info('Fetching pm2 version:', pm2RPC);
  pm.version(pm2RPC, function (err, version) {
    socket.emit('pm2_ver', (err || !version) ? '0.0.0' : version);
  });
};

/**
 * Broadcast to all connected clients.
 * @param {String} event
 * @param {Object} data
 * @param {String} nsp
 * @private
 */
Monitor.prototype._broadcast = function (event, data, nsp) {
  nsp = nsp || conf.NSP.SYS;

  if (this._noClient) {
    return console.debug('No client is connecting, ignore broadcasting', event, 'to', nsp)
  }
  console.debug('Broadcasting', event, 'to', nsp);
  this._sockio.of(nsp).emit(event, data);
};

/**
 * Destroy tails.
 * @param  {Number} pm_id
 * @return {[type]}
 */
Monitor.prototype._killTailProcess = function (pm_id) {
  var self = this;

  function killTail(id) {
    var tail = self._tails[id];
    if (!tail) {
      return;
    }
    try {
      tail.kill('SIGTERM');
    } catch (err) {}

    delete self._tails[id];
    console.info('[pm2:' + id + ']', 'tail destroyed!');
  }
  if (!isNaN(pm_id)) {
    return killTail(pm_id);
  }

  var socks = self._sockio.of(conf.NSP.LOG).sockets,
    canNotBeDeleted = {};
  if (socks && socks.length > 0) {
    socks.forEach(function (sock) {
      canNotBeDeleted[sock._pm_id] = 1;
    });
  }

  for (var pm_id in self._tails) {
    if (!canNotBeDeleted[pm_id]) {
      killTail(pm_id);
    }
  }
};

/**
 * Listening all the nsp.
 */
Monitor.prototype._listeningSocketIO = function () {
  if (!this._sockio || this._sockio._listening) {
    console.warn('Avoid duplicated listening!');
    return;
  }

  this._sockio._listening = true;
  for (var nsp in conf.NSP) {
    this._sockio.of(conf.NSP[nsp]).on('connection', this['_connect' + (nsp[0] + nsp.toLowerCase().slice(1)) + 'Sock'].bind(this));
    console.info('Listening connection event on', nsp.toLowerCase());
  }

  var auth;
  if (!(this.options.agent && (auth = this.options.agent.authorization))) {
    return;
  }
  this._sockio.use(function (socket, next) {
    if (auth !== socket.handshake.query.auth) {
      return next(new Error('unauthorized'));
    }
    next();
  });
};

/**
 * List all available monitors.
 * @param  {Object} options
 * @return {Object}
 */
Monitor.available = function (options) {
  options.agent = options.agent || {};
  var remotable = options.remotes && _.keys(options.remotes).length > 0;

  if (options.agent.offline && !remotable) {
    return null;
  }

  options.port = options.port || 8088;

  var q = {
      name: 'socket_server',
      message: 'Which socket server would you wanna connect to',
      type: 'list',
      choices: []
    },
    wrapLocal = function () {
      return {
        value: (options.agent && options.agent.authorization ? options.agent.authorization + '@' : '') + '127.0.0.1:' + options.port,
        short: 'localhost'
      };
    };
  if (!remotable) {
    q.choices = [wrapLocal()];
    return q;
  }
  var maxShortLength = 0;
  for (var remote in options.remotes) {
    var connectionString = options.remotes[remote];
    q.choices.push({
      value: connectionString,
      short: remote
    });
    maxShortLength = Math.max(maxShortLength, remote.length);
  }
  if (!options.agent.offline) {
    var conn = wrapLocal();
    q.choices.push(conn);
    maxShortLength = Math.max(maxShortLength, conn.short.length);
  }

  if (q.choices.length > 1) {
    q.choices.forEach(function (c) {
      c.name = '[' + c.short + Array(maxShortLength - c.short.length + 1).join(options.blank || ' ') + '] ' + c.value;
    });
  }

  return q;
};

/**
 * Convert connection object to string.
 * @param  {Object} connection
 * @return {String}
 */
Monitor.toConnectionString = function (connection) {
  var uri = (connection.protocol || 'http:') + '//' + (connection.hostname || '127.0.0.1') + ':' + connection.port +
    (connection.path || '') + (connection.namespace || '');

  if (connection.authorization) {
    uri += (uri.indexOf('?') > 0 ? '&' : '?') + 'auth=' + connection.authorization;
  }
  return uri;
};

/**
 * Parse connection string to an uri object.
 * @param  {String} connectionString
 * @return {Object}
 */
Monitor.parseConnectionString = function (connectionString) {
  var connection = {
    port: 8088,
    hostname: '127.0.0.1',
    authorization: ''
  };
  var lastAt = connectionString.lastIndexOf('@');
  if (lastAt >= 0) {
    connection.authorization = connectionString.slice(0, lastAt);
    connectionString = connectionString.slice(lastAt + 1);
  }
  if (!/^http(s)?:\/\//i.test(connectionString)) {
    connectionString = 'http://' + connectionString;
  }

  if (connectionString) {
    connectionString = url.parse(connectionString);
    connection.hostname = connectionString.hostname;
    connection.port = connectionString.port;
    connection.path = _.trimLeft(connectionString.path, '/');
    connection.protocol = connectionString.protocol;
  }
  return connection;
};

Object.defineProperty(Monitor.prototype, 'sockio', {
  set: function (io) {
    if (this._sockio) {
      this._sockio.close();
    }
    this._sockio = io;
    this._listeningSocketIO();
  },
  get: function () {
    return this._sockio;
  }
});
