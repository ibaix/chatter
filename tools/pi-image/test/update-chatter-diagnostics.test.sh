#!/usr/bin/env bash
# Tests for the diagnostics parts of in-pi/update-chatter.sh: the restart request ("reboot"), network.json,
# and helper.log. Chatter shows them in Settings > Diagnostics, so nobody needs SSH to debug the Pi.
# It runs in a Debian 13 container (see in-linux.sh), with fake docker, ip, systemctl, dpkg, and df.
# Run:  tools/pi-image/test/update-chatter-diagnostics.test.sh
set -uo pipefail
if [ "${IN_TEST_CONTAINER:-}" != 1 ]; then exec "$(dirname "$0")/in-linux.sh" "$0"; fi
# shellcheck source-path=SCRIPTDIR source=update-chatter.lib.sh
source "$(dirname "$0")/update-chatter.lib.sh"

network_file() { echo "$root/opt/chatter/update/network.json"; }
helper_log() { echo "$root/opt/chatter/update/helper.log"; }

reboot_was_asked() {
  grep -qx -- "--no-block reboot" "$fake/systemctl.log" 2> /dev/null
}

reboot_count() {
  grep -cx -- "--no-block reboot" "$fake/systemctl.log" 2> /dev/null || true
}

test_a_reboot_request_restarts_the_pi() {
  set_up
  send_request reboot
  check "a reboot request restarts the Pi" reboot_was_asked
  check "the request is taken out of the inbox" test ! -e "$inbox/request.json"
  check "the time of the restart is kept, root only" test "$(stat --format %a "$state_dir/last-reboot")" = 600
  check "the restart is in helper.log" grep -q "\[request\] Restarting the Pi, as Chatter asked." "$(helper_log)"
  check "a reboot writes no update status" test ! -e "$(status_file)"
}

test_a_second_reboot_soon_after_is_refused() {
  set_up
  send_request reboot
  send_request reboot
  check "a second restart within 15 minutes is refused" test "$(reboot_count)" = 1
  check "the refusal is in helper.log" grep -q "Refused to restart the Pi: the last restart was less than 15 minutes ago." "$(helper_log)"

  echo $(($(date +%s) - 901)) > "$state_dir/last-reboot"
  send_request reboot
  check "a restart after 15 minutes is allowed" test "$(reboot_count)" = 2

  echo "not a time" > "$state_dir/last-reboot"
  send_request reboot
  check "a broken time file does not stop a restart" test "$(reboot_count)" = 3
}

test_no_reboot_while_the_helper_works() {
  local holder
  set_up
  flock "$state_dir/lock" sleep 2 &
  holder=$!
  sleep 0.5
  send_request reboot
  check "no restart while a check or an install holds the lock" test ! -e "$fake/systemctl.log"
  check "the request is dropped, so it does not run later" test ! -e "$inbox/request.json"
  wait "$holder"

  set_up
  printf '%s\n' "phase=swapped" "version=$NEW_VERSION" "old_version=$OLD_VERSION" > "$state_dir/state"
  send_request reboot
  check "no restart while an install is not complete" test ! -e "$fake/systemctl.log"
}

test_only_the_exact_text_reboot_is_a_request() {
  local text
  for text in "reboot
" "REBOOT" "reboot now" "shutdown"; do
    set_up
    send_request "$text"
    check "the request \"${text//$'\n'/\\n}\" does not restart the Pi" test ! -e "$fake/systemctl.log"
  done
}

test_network_json() {
  set_up
  run_helper recover
  check "recover writes network.json" test -f "$(network_file)"
  check "Chatter can read network.json" test "$(stat --format %a "$(network_file)")" = 644
  check "network.json has the name, the addresses, the gateway and SSH" grep -qE \
    '^\{"hostname":"chatter","localName":"chatter.local","addresses":\[\{"interface":"eth0","address":"192.168.1.20/24"\}\],"gateway":"192.168.1.1","ssh":true,"updatedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"\}$' \
    "$(network_file)"

  set_up
  FAKE_IP6_ADDRESSES="2: eth0    inet6 fd00::20/64 scope global dynamic" FAKE_SSH=inactive run_helper facts
  check "facts writes IPv6 addresses too, and SSH off" grep -q \
    '"addresses":\[{"interface":"eth0","address":"192.168.1.20/24"},{"interface":"eth0","address":"fd00::20/64"}\],"gateway":"192.168.1.1","ssh":false' \
    "$(network_file)"
}

test_network_json_leaves_out_values_with_the_wrong_shape() {
  set_up
  echo 'bad"name' > "$root/etc/hostname"
  FAKE_IP_ADDRESSES='2: eth0"x    inet 192.168.1.20/24 scope global eth0
3: wlan0    inet 999.1.1.1/24 scope global wlan0
4: wlan0    inet 10.0.0.7/8 scope global wlan0' FAKE_GATEWAY='1.2.3.4","x' run_helper facts
  check "a bad host name, interface, address and gateway are left out" grep -qE \
    '^\{"addresses":\[\{"interface":"wlan0","address":"10.0.0.7/8"\}\],"ssh":true,"updatedAt":"[^"]+"\}$' "$(network_file)"

  set_up
  FAKE_IP_ADDRESSES="$(for n in $(seq 1 12); do echo "$n: eth$n    inet 10.0.0.$n/24 scope global eth$n"; done)" run_helper facts
  check "at most 8 addresses" test "$(grep -o '"interface"' "$(network_file)" | wc -l)" = 8
}

test_helper_log() {
  set_up
  put_update_file > /dev/null
  send_request check
  check "the helper writes its steps to helper.log" grep -q "\[request\] Step: signature." "$(helper_log)"
  check "each line of helper.log has the time" grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z \[request\] ' "$(helper_log)"
  check "Chatter can read helper.log" test "$(stat --format %a "$(helper_log)")" = 644

  set_up
  head --bytes $((256 * 1024)) /dev/zero | tr '\0' 'x' > "$(helper_log)"
  send_request nothing
  check "a full helper.log becomes helper.log.1" test "$(stat --format %s "$(helper_log).1")" = $((256 * 1024))
  check "a new helper.log starts" test "$(wc -l < "$(helper_log)")" = 1
}

test_a_reboot_request_restarts_the_pi
test_a_second_reboot_soon_after_is_refused
test_no_reboot_while_the_helper_works
test_only_the_exact_text_reboot_is_a_request
test_network_json
test_network_json_leaves_out_values_with_the_wrong_shape
test_helper_log
finish_tests
