# Builder
FROM node:10-slim as builder

RUN apt-get update \
 && apt-get install -y git python build-essential libicu-dev

RUN git clone https://github.com/matrix-org/freebindfree.git \
 && cd freebindfree \
 && make

COPY ./package.json ./package.json
RUN npm install

# App
FROM node:10-slim

RUN apt-get update \
 && apt-get install -y sipcalc iproute2 openssl --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir app

WORKDIR /app
RUN mkdir ./data
RUN openssl genpkey -out ./data/passkey.pem -outform PEM -algorithm RSA -pkeyopt rsa_keygen_bits:2048

COPY --from=builder /node_modules /app/node_modules
COPY --from=builder /freebindfree/libfreebindfree.so /app/libfreebindfree.so

COPY config.yaml /app/config.yaml
COPY passkey.pem /app/passkey.pem
COPY appservice-registration-irc.yaml /app/appservice-registration-irc.yaml
COPY app.js /app/
COPY lib /app/lib
COPY docker /app/docker

ENV LD_PRELOAD /app/libfreebindfree.so

ENTRYPOINT ["/app/docker/start.sh"]
