FROM node:26.5.0-bookworm-slim
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends bash git ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/dsh-arc
COPY docker/dsh-arc.tgz /tmp/dsh-arc.tgz
RUN tar -xzf /tmp/dsh-arc.tgz --strip-components=1 -C /opt/dsh-arc \
    && rm /tmp/dsh-arc.tgz \
    && mkdir -p /data /workspace && chown node:node /data /workspace
ENV DSH_ARC_HOME=/data
ENV HOME=/data
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/dsh-arc/src/cli.mjs"]
CMD ["runtime"]
