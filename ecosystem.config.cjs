module.exports = {
  apps: [
    {
      name: "html2app",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      // Electron/gradle builds spike past 1G, and a restart mid-build kills the
      // in-flight job (client sees it vanish). Give headroom; lower only if the
      // box is small and you'd rather kill builds than risk a system OOM.
      max_memory_restart: "2G",
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
