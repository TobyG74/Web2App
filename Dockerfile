FROM node:20-bookworm

ARG WITH_ANDROID=1
ARG WITH_WINE=1
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && if [ "$WITH_ANDROID" = "1" ]; then apt-get install -y --no-install-recommends openjdk-17-jdk-headless; fi \
    && if [ "$WITH_WINE" = "1" ]; then \
         dpkg --add-architecture i386 && apt-get update \
         && apt-get install -y --no-install-recommends wine wine64; fi \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk

# Android SDK
RUN if [ "$WITH_ANDROID" = "1" ]; then \
      mkdir -p $ANDROID_HOME/cmdline-tools \
      && curl -fsSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
      && unzip -q /tmp/cmdtools.zip -d $ANDROID_HOME/cmdline-tools \
      && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
      && rm /tmp/cmdtools.zip \
      && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
      && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
           "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null ; \
    fi
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=4444
EXPOSE 4444
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:4444/ >/dev/null || exit 1
CMD ["node", "server.js"]
