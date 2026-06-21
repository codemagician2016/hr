module.exports = {
  apps: [{
    name: 'sitepresso-backend',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
