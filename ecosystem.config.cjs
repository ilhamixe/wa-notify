module.exports = {
  apps: [
    {
      name: "wa-notify",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production" },
      time: true,
      kill_timeout: 5000,
    },
  ],
};
