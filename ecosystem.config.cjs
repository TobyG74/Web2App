module.exports = {
  apps: [
    {
      name: "html2app",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G", // Electron/gradle builds are memory-heavy
      env: {
        NODE_ENV: "production",
        PORT: 4444,
        ANDROID_HOME: `${process.env.HOME}/Android/Sdk`,
        PATH: `${process.env.HOME}/Android/Sdk/cmdline-tools/latest/bin:${process.env.HOME}/Android/Sdk/platform-tools:${process.env.PATH}`,
        JAVA_HOME: "/usr/lib/jvm/java-17-openjdk-amd64",
      },
    },
  ],
};
