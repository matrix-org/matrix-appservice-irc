FROM node:6-slim

RUN apt-get update && apt-get install -y git sipcalc make gcc libc6-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/matrix-org/freebindfree.git \
 && cd freebindfree \
 && make

COPY . /app

WORKDIR app

RUN npm install

ENV LD_PRELOAD /freebindfree/libfreebindfree.so

ENTRYPOINT [  "/app/docker/start.sh" ]

