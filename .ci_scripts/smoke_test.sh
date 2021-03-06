#!/bin/bash

set -e

## Get Streamr Docker dev
git clone --depth 1 https://github.com/streamr-dev/streamr-docker-dev.git

## Script for preparing smoke test
sudo ifconfig docker0 10.200.10.1/24

## Switch out image for local one
sed -i "s#$OWNER/$IMAGE_NAME:dev#$OWNER/$IMAGE_NAME\:taggit#g" $GITHUB_WORKSPACE/streamr-docker-dev/docker-compose.override.yml

## Start up services needed
$GITHUB_WORKSPACE/streamr-docker-dev/streamr-docker-dev/bin.sh start broker-node-no-storage-1 parity-node0 --wait

## Wait for the service to come online and test
## TODO: can this be replaced with `--wait`?
wait_time=10;
for (( i=0; i < 5; i=i+1 )); do
    curl -s http://localhost:8791/api/v1/volume;
    res=$?;
    if test "$res" != "0"; then
        echo "Attempting to connect to broker retrying in $wait_time seconds";
        sleep $wait_time;
        wait_time=$(( 2*wait_time )) ;
    else
        exit 0
    fi;
done;
exit 1
