"""
With IVR_TIMEOUT, the IVR ends the call when no meeting is chosen in time. The
room screen counts down to that moment: prompt() gives the page the end time, in
milliseconds, as window.ivrDeadline.
"""
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

RUNTIME_ONLY = ("qrcode", "requests", "selenium", "selenium.webdriver",
                "selenium.webdriver.chrome", "selenium.webdriver.chrome.service",
                "selenium.webdriver.support", "selenium.webdriver.support.ui")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../src"))
with patch.dict(sys.modules, {name: MagicMock() for name in RUNTIME_ONLY if name not in sys.modules}):
    import ivr as ivr_module

DEADLINE = "window.ivrDeadline = arguments[0];"


def prompted(monkeypatch, timeout):
    if timeout is None:
        monkeypatch.delenv("IVR_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("IVR_TIMEOUT", timeout)
    with patch.object(ivr_module.os, "makedirs", side_effect=OSError("read-only")):
        ivr = ivr_module.IVR(width=1280, height=720)
    ivr.readPairingCode = MagicMock()
    ivr.interact = MagicMock()
    ivr.driver = MagicMock()
    answers = {"return window.browsing": "dev", "return window.room": {"roomName": "room1"}}
    ivr.driver.execute_script.side_effect = lambda script, *args: answers.get(script)
    with patch.object(ivr_module.time, "time", return_value=1000.0):
        result = ivr.prompt()
    return ivr, result


def deadline_calls(ivr):
    return [c.args for c in ivr.driver.execute_script.call_args_list if c.args[0] == DEADLINE]


def test_the_page_gets_the_end_of_the_call(monkeypatch):
    ivr, result = prompted(monkeypatch, "300")
    assert deadline_calls(ivr) == [(DEADLINE, 1300000)]
    assert result == ("dev", {"roomName": "room1"})


def test_the_end_time_is_set_before_the_ivr_waits_for_the_caller(monkeypatch):
    ivr, _ = prompted(monkeypatch, "180")
    scripts = [c.args[0] for c in ivr.driver.execute_script.call_args_list]
    assert scripts.index(DEADLINE) < scripts.index("return window.browsing")


@pytest.mark.parametrize("timeout", [None, ""])
def test_no_timeout_no_countdown(monkeypatch, timeout):
    ivr, result = prompted(monkeypatch, timeout)
    assert deadline_calls(ivr) == []
    assert result == ("dev", {"roomName": "room1"})
