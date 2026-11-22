#!/bin/sh
# Stop what start.sh started
docker stop chatter-test-vmalert chatter-test-victoriametrics >/dev/null 2>&1 || true
docker network rm chatter-victoria-test >/dev/null 2>&1 || true
