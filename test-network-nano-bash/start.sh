#!/usr/bin/env sh
set -euo pipefail

/bin/sh ./generate_artifacts.sh

# TODO remove sleeps and fix "Error: got unexpected status: SERVICE_UNAVAILABLE -- no Raft leader" properly!
sleep 5

/bin/sh orderer1.sh > ./logs/orderer1.log 2>&1 &
/bin/sh orderer2.sh > ./logs/orderer2.log 2>&1 &
/bin/sh orderer3.sh > ./logs/orderer3.log 2>&1 &

sleep 5

/bin/sh peer1.sh > ./logs/peer1.log 2>&1 &
/bin/sh peer2.sh > ./logs/peer2.log 2>&1 &
/bin/sh peer3.sh > ./logs/peer3.log 2>&1 &

sleep 5

source peer1admin.sh
source peer2admin.sh
source peer3admin.sh
