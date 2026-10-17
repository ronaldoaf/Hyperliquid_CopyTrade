module.exports = {
  apps: [{
    name: 'copytrade-dashboard',
    script: 'server.js',
    cwd: __dirname,
    node_args: '--env-file-if-exists=.env --disable-warning=ExperimentalWarning',
    max_memory_restart: '300M',
  }],
};
