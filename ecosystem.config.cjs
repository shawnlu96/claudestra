module.exports = {
  apps: [
    {
      name: "discord-bridge",
      script: "src/bridge.ts",
      interpreter: process.env.HOME + "/.bun/bin/bun",
      cwd: __dirname,
      env_file: ".env",
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
    },
    {
      name: "master-launcher",
      script: "src/launcher.ts",
      interpreter: process.env.HOME + "/.bun/bin/bun",
      cwd: __dirname,
      env_file: ".env",
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
    },
    {
      name: "cron-scheduler",
      script: "src/cron.ts",
      interpreter: process.env.HOME + "/.bun/bin/bun",
      cwd: __dirname,
      env_file: ".env",
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
