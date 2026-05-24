module.exports = {
  apps: [
    {
      name: 'hermes-backend',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: '/var/log/hermes/error.log',
      out_file: '/var/log/hermes/out.log',
      merge_logs: true,
      time: true
    }
  ]
};
