// pm2 app definition. The app directory is a deploy-only git checkout of this repo.
module.exports = {
  apps: [
    {
      name: 'syntone',
      script: 'server/main.js',
      cwd: __dirname + '/..',
      env: {
        PORT: 3002,
        HOST: '0.0.0.0',
      },
      max_memory_restart: '200M',
    },
  ],
}
