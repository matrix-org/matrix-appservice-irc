FROM node:6-slim

RUN apt-get update && apt-get install -y git sipcalc make gcc libc6-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ARG VERSION=0.8.0

RUN npm install matrix-appservice-irc@$VERSION --global

RUN git clone https://github.com/matrix-org/freebindfree.git \
 && cd freebindfree \
 && make \
 && mv libfreebindfree.so /usr/local/lib/node_modules/matrix-appservice-irc/

# workaround for not found lib/config/schema.yaml
WORKDIR /usr/local/lib/node_modules/matrix-appservice-irc

# ldpreload
ENV LD_PRELOAD /usr/local/lib/node_modules/matrix-appservice-irc/libfreebindfree.so

# start script
COPY docker/start.sh /start.sh

ENTRYPOINT [  "/start.sh" ]

