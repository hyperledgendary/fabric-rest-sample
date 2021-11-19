FROM alpine:3.14 AS build

WORKDIR /build

ENV HLF_VERSION=2.4.0-beta

RUN apk --no-cache add curl dumb-init
RUN curl -L --retry 5 --retry-delay 3 "https://github.com/hyperledger/fabric/releases/download/v${HLF_VERSION}/hyperledger-fabric-linux-amd64-${HLF_VERSION}.tar.gz" | tar xz

FROM alpine:3.14

ENV FABRIC_CFG_PATH /etc/hyperledger/fabric

RUN apk --no-cache add libc6-compat
COPY --from=build /usr/bin/dumb-init /usr/bin/dumb-init
COPY --chown=root:root --from=build /build/bin/* /usr/local/bin/
COPY --chown=root:root --from=build /build/config/* ${FABRIC_CFG_PATH}/

RUN addgroup -g 500 nanofab && adduser -u 500 -D -h /home/nanofab -G nanofab nanofab
USER nanofab
WORKDIR /home/nanofab

COPY --chown=nanofab:nanofab *.sh *.yaml ./network/
RUN mkdir -p ./network/logs && ln -s /usr/local/bin ./bin && ln -s ${FABRIC_CFG_PATH} ./config

WORKDIR /home/nanofab/network
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/home/nanofab/network/start.sh"]
