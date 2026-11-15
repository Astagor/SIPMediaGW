"""
When the SIP address names a group of platforms, the room screen shows only that
group. The phone gets the platforms from getIvrConfig(): the same ones, in the
same order, so that the phone and the room screen number them alike.
"""
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))
from HTTPLauncher import DockerGateway

CONFIG = {
    "menus": {"edumeet": []},
    "webrtc_domains": {
        "arnes": {"name": "ARNES", "domain": "edumeet.arnes.si"},
        "pcss": {"name": "PCSS", "domain": "edumeet.pcss.pl"},
        "dev": {"name": "eduMEET dev", "domain": "dev.edumeet.eu", "groups": ["pcss"]},
    },
}


def process(out):
    p = MagicMock()
    p.returncode = 0
    p.communicate.return_value = (out, b"")
    return p


def ivr_config(shown=None, error=None):
    gw = DockerGateway()
    browser = MagicMock(return_value=shown, side_effect=error)
    with patch("HTTPLauncher.DockerGateway.get_gw_info", return_value={"Name": "gw-container"}), \
            patch("subprocess.Popen", side_effect=[process(json.dumps(CONFIG).encode()), process(b"3\n")]) as popen, \
            patch.object(DockerGateway, "executeInExistingChromeSession", browser):
        result = gw.getIvrConfig("gw1")
    return result, popen, browser


def test_the_phone_gets_the_platforms_of_the_room_screen():
    result, _, _ = ivr_config(["pcss", "dev"])
    assert list(result["webrtc_domains"]) == ["pcss", "dev"]
    assert result["webrtc_domains"]["dev"]["domain"] == "dev.edumeet.eu"


def test_the_order_of_the_room_screen_is_kept():
    result, _, _ = ivr_config(["dev", "arnes"])
    assert list(result["webrtc_domains"]) == ["dev", "arnes"]


def test_a_key_that_is_not_in_the_config_is_left_out():
    result, _, _ = ivr_config(["pcss", "gone"])
    assert list(result["webrtc_domains"]) == ["pcss"]


def test_all_platforms_without_a_group():
    result, _, _ = ivr_config(None)
    assert list(result["webrtc_domains"]) == ["arnes", "pcss", "dev"]


def test_all_platforms_when_the_browser_cannot_answer():
    result, _, _ = ivr_config(error=RuntimeError("no browser session on this gateway"))
    assert list(result["webrtc_domains"]) == ["arnes", "pcss", "dev"]
    assert result["status"] == "success"


def test_the_room_screen_of_this_gateway_is_asked():
    _, popen, browser = ivr_config(["pcss"])
    assert popen.call_args_list[1].args[0] == ["docker", "exec", "gw-container", "printenv", "GW_ID"]
    assert browser.call_args.args == ("3", "return window.shownDomainKeys || null;")
