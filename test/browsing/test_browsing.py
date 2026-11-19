"""
The Browsing base class drives the meeting page for every connector: it starts
Chromium, loads the connector, waits for the join, shows the DTMF menu, relays
the keys, streams the shared slides to the room system and ends the call.
The browser is replaced, and so are the commands sent to baresip.
"""
import ast
import copy
import os
import queue
import sys
import types
from unittest.mock import MagicMock, call, patch

import pytest


def selenium_exceptions():
    module = types.ModuleType("selenium.common.exceptions")

    class WebDriverException(Exception):
        pass

    class NoSuchWindowException(WebDriverException):
        pass

    module.WebDriverException = WebDriverException
    module.NoSuchWindowException = NoSuchWindowException
    return module


STAND_INS = {
    "selenium": MagicMock(),
    "selenium.webdriver": MagicMock(),
    "selenium.common": MagicMock(),
    "selenium.common.exceptions": selenium_exceptions(),
}

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../src"))
with patch.dict(sys.modules, {name: module for name, module in STAND_INS.items() if name not in sys.modules}):
    import browsing as browsing_module

ASSETS = os.path.normpath(os.path.join(os.path.dirname(browsing_module.__file__), "../browsing/assets"))
ENV = ("AUDIO_ONLY", "DUAL_SCREEN_LAYOUT", "DUAL_SCREEN_BY_DEFAULT", "ENDING_TIMEOUT", "VID_SIZE_SLIDE", "GW_NAME")


def baresip(command):
    return call([f'echo "{command}" | netcat -q 1 127.0.0.1 5555'], shell=True)


ROOM = {
    "config": {
        "webrtc_domain": "meet.example.org",
        "lang": "en",
        "ivr_prompts": {"en": {"room": "Enter the room number"}},
        "menus": {"fakeconnector": [{"key": "1", "label": "Microphone"}]},
    },
    "roomName": "room1",
    "displayName": "Room A",
    "roomToken": "token1",
}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)


def new_session(**kwargs):
    args = {"width": 1280, "height": 720, "config": {"lang": "en"}, "modName": "fakeconnector",
            "room": copy.deepcopy(ROOM), "name": "Room A", "chromeOptions": MagicMock(),
            "inputs": queue.Queue(), "readPairingCode": MagicMock()}
    args.update(kwargs)
    return browsing_module.Browsing(**args)


def with_driver(session, answer=None):
    session.driver = MagicMock()
    if callable(answer):
        session.driver.execute_script.side_effect = answer
    else:
        session.driver.execute_script.return_value = answer
    return session


def scripts(session):
    return [c.args[0] for c in session.driver.execute_script.call_args_list]


# Construction

def test_a_call_with_video_shows_the_browser():
    session = new_session()
    session.chromeOptions.add_argument.assert_not_called()


def test_an_audio_only_call_runs_the_browser_headless(monkeypatch):
    monkeypatch.setenv("AUDIO_ONLY", "true")
    session = new_session()
    assert session.chromeOptions.add_argument.call_args_list == [
        call("--headless=new"), call("--use-fake-ui-for-media-stream")]


def connector_values(session):
    """The string values that the init script gives to the connector."""
    prefix = "window.meeting = new window.Browsing("
    assert session.initScript.startswith(prefix) and session.initScript.endswith(")")
    return ast.literal_eval("(" + session.initScript[len(prefix):-1] + ",)")


def test_the_connector_gets_the_meeting_values():
    assert connector_values(new_session()) == (
        "meet.example.org", "room1", "Room A", "en", '{"en": {"room": "Enter the room number"}}',
        "token1", "None", "False")


@pytest.mark.parametrize("layout, by_default, expected", [
    ("true", "true", "True"),
    ("true", None, "False"),
    (None, "true", "False"),
])
def test_the_dual_screen_starts_on_only_when_both_settings_say_so(monkeypatch, layout, by_default, expected):
    if layout:
        monkeypatch.setenv("DUAL_SCREEN_LAYOUT", layout)
    if by_default:
        monkeypatch.setenv("DUAL_SCREEN_BY_DEFAULT", by_default)
    assert connector_values(new_session())[7] == expected


def test_the_connector_learns_that_the_call_is_audio_only(monkeypatch):
    monkeypatch.setenv("AUDIO_ONLY", "true")
    assert connector_values(new_session())[5:] == ("token1", "true", "False")


def test_the_base_hooks_do_nothing():
    session = with_driver(new_session())
    assert session.loadPage() is None
    assert session.browse() is None
    assert session.unset() is None
    session.driver.execute_script.assert_not_called()


# Scripts and images

def test_a_script_is_run_after_the_page_gets_the_style_sheet(tmp_path):
    script = tmp_path / "connector.js"
    script.write_text("console.log('é');", encoding="utf-8")
    session = with_driver(new_session())
    session.loadJS(str(script))
    css = os.path.join(os.path.dirname(browsing_module.__file__), "../browsing/assets/IVR/style.css")
    assert scripts(session) == [f"window.cssPath = 'file://{css}';", "console.log('é');"]


def test_the_join_loads_the_helpers_then_the_connector_then_joins():
    session = with_driver(new_session())
    order = MagicMock()
    session.loadJS = order.loadJS
    session.driver.execute_script.side_effect = lambda script, *args: order.execute_script(script)
    session.join()
    loaded = [os.path.normpath(c.args[0]) for c in order.method_calls if c[0] == "loadJS"]
    assert loaded == [os.path.join(ASSETS, name) for name in ("uihelper.js", "slidestreamer.js", "fakeconnector.js")]
    assert order.method_calls[3:] == [call.execute_script(session.initScript),
                                      call.execute_script("window.meeting.join();")]


def test_the_menu_images_are_read_as_data_urls(tmp_path):
    (tmp_path / "icon.png").write_bytes(b"ICON")
    (tmp_path / "dtmf_fr.png").write_bytes(b"DTMF")
    icons = tmp_path / "IVR" / "images" / "menu-icons"
    icons.mkdir(parents=True)
    (icons / "mic.png").write_bytes(b"MIC")
    (icons / "camera.PNG").write_bytes(b"CAM")
    (icons / "notes.txt").write_bytes(b"not an image")
    session = new_session()
    session.loadImages(str(tmp_path), "fr")
    assert session.iconB64 == "data:image/png;base64,SUNPTg=="
    assert session.dtmfB64 == "data:image/png;base64,RFRNRg=="
    assert session.menuIcons == {"mic": "data:image/png;base64,TUlD", "camera": "data:image/png;base64,Q0FN"}


# The call ends when the gateway stays alone

class Clock:
    def __init__(self):
        self.now = 0.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def counted_page(*counts):
    """A page that answers the participant counts in turn, then loses the connector."""
    answers = list(counts)
    asked = []

    def answer(script, *args):
        if script == "return('getParticipantNum' in window.meeting)":
            return bool(answers)
        asked.append(script)
        value = answers.pop(0)
        if isinstance(value, Exception):
            raise value
        return value
    return answer, asked


def watch_participants(*counts, threshold=300, interval=60):
    answer, asked = counted_page(*counts)
    session = with_driver(new_session(), answer)
    clock = Clock()
    with patch.object(browsing_module.subprocess, "run") as run, \
            patch.object(browsing_module.time, "time", clock.time), \
            patch.object(browsing_module.time, "sleep", clock.sleep):
        thread = session.monitorSingleParticipant(threshold, checkInterval=interval)
        thread.join(timeout=5)
        assert not thread.is_alive()
    return run, asked, clock


def test_the_call_ends_when_the_gateway_has_been_alone_for_the_timeout():
    run, asked, clock = watch_participants(*[1] * 10)
    assert run.call_args_list == [baresip("/quit")]
    assert len(asked) == 6
    assert clock.now == 300


def test_another_participant_starts_the_wait_again():
    run, _, clock = watch_participants(1, 1, 2, *[1] * 10)
    assert run.call_args_list == [baresip("/quit")]
    assert clock.now == 480


def test_an_unknown_participant_count_starts_the_wait_again():
    run, _, clock = watch_participants(1, 1, RuntimeError("script timeout"), *[1] * 10)
    assert run.call_args_list == [baresip("/quit")]
    assert clock.now == 480


def test_the_call_goes_on_while_others_are_in_the_meeting():
    run, asked, _ = watch_participants(*[3] * 10)
    run.assert_not_called()
    assert len(asked) == 10


# Layout

def test_a_single_screen_layout_needs_no_script():
    session = with_driver(new_session())
    session.manageLayout()
    session.driver.execute_script.assert_not_called()


@pytest.mark.parametrize("size, expected", [(None, "1280x720"), ("1920x1080", "1920x1080")])
def test_the_dual_screen_layout_streams_the_slides_at_the_slide_size(monkeypatch, size, expected):
    monkeypatch.setenv("DUAL_SCREEN_LAYOUT", "true")
    if size:
        monkeypatch.setenv("VID_SIZE_SLIDE", size)
    session = with_driver(new_session(), lambda script, *args: "#slides" if "slideSelector;" in script else None)
    session.manageLayout()
    layout, selector = session.driver.execute_script.call_args_list
    assert "new SlideStreamer(" in layout.args[0] and "slideStreamer.stop()" in layout.args[0]
    assert layout.args[1:] == (expected,)
    assert selector.args == ("return window.meeting.slideSelector;",)
    assert session.slideSelector == "#slides"


# Slides shared in the meeting go to the room system as the second video

def slide_check(session, streamed):
    session.driver.execute_script.return_value = streamed
    with patch.object(browsing_module.subprocess, "run") as run:
        session.checkStreamedSlide()
    return run


def test_shared_slides_start_the_second_video(monkeypatch):
    monkeypatch.setenv("VID_SIZE_SLIDE", "1920x1080")
    session = with_driver(new_session())
    run = slide_check(session, True)
    assert run.call_args_list == [baresip("/slidesrc avformat,http://0.0.0.0:8080,1920x1080,5,1000000"),
                                  baresip("/floorreq")]
    assert session.streamedSlide is True
    assert slide_check(session, True).call_count == 0


def test_the_end_of_the_slides_stops_the_second_video():
    session = with_driver(new_session())
    session.streamedSlide = True
    run = slide_check(session, False)
    assert run.call_args_list == [baresip("/floorrel"), baresip("/slidesrc fakevideo,nil,2x2,1,1000")]
    assert session.streamedSlide is False


def test_the_room_systems_own_screen_share_has_priority():
    session = with_driver(new_session())
    session.screenShared = True
    assert slide_check(session, True).call_count == 0
    session.streamedSlide = True
    run = slide_check(session, True)
    assert run.call_args_list == [baresip("/floorrel"), baresip("/slidesrc fakevideo,nil,2x2,1,1000")]


def test_no_slides_without_a_browser():
    session = new_session()
    with patch.object(browsing_module.subprocess, "run") as run:
        session.checkStreamedSlide()
    run.assert_not_called()


def test_a_closed_browser_window_is_forgotten():
    session = with_driver(new_session())
    session.driver.execute_script.side_effect = browsing_module.NoSuchWindowException("window closed")
    with patch.object(browsing_module.subprocess, "run") as run:
        session.checkStreamedSlide()
    assert session.driver is None
    run.assert_not_called()


def test_a_browser_error_keeps_the_browser():
    session = with_driver(new_session())
    driver = session.driver
    driver.execute_script.side_effect = browsing_module.WebDriverException("script timeout")
    with patch.object(browsing_module.subprocess, "run") as run:
        session.checkStreamedSlide()
    assert session.driver is driver
    run.assert_not_called()


# Keys from the room system

def test_no_key_no_script():
    session = with_driver(new_session())
    session.interact()
    session.driver.execute_script.assert_not_called()


@pytest.mark.parametrize("key, shared", [("1", False), ("s", True), ("q", False)])
def test_a_key_goes_to_the_menu_or_the_meeting_page(key, shared):
    session = with_driver(new_session())
    session.screenShared = key == "q"
    session.userInputs.put(key)
    session.interact()
    assert scripts(session) == [(f"if(window.menu){{window.menu.interact('{key}');}}"
                                 f"else if(window.meeting){{window.meeting.interact('{key}');}}")]
    assert session.screenShared is shared


# The whole session

def running(session, joined=(False, True), loops=1):
    """Replaces the steps of run() so that their order and arguments show."""
    steps = MagicMock()
    for name in ("loadPage", "join", "monitorLeftMeeting", "monitorSingleParticipant",
                 "loadImages", "loadJS", "checkStreamedSlide", "manageLayout", "interact"):
        setattr(session, name, getattr(steps, name))
    def load_images(path, lang):
        session.iconB64, session.dtmfB64, session.menuIcons = "ICON", "DTMF", {"mic": "MIC"}
    session.loadImages.side_effect = load_images

    def one_loop():
        if steps.checkStreamedSlide.call_count > loops:
            raise RuntimeError("the session did not stop")
    session.checkStreamedSlide.side_effect = one_loop
    pairings = []

    def read_pairing_code(driver):
        pairings.append(driver)
        if len(pairings) > loops:
            session.room = {}
    session.readPairingCode = read_pairing_code
    answers = list(joined)
    driver = MagicMock()
    driver.execute_script.side_effect = lambda script, *args: answers.pop(0) if script == "return window.meeting.joined" else None
    return steps, pairings, driver


def run_session(session, driver, rtcstats=False):
    with patch.object(browsing_module, "webdriver") as webdriver, \
            patch.object(browsing_module.rtcstatsTrace, "prepare", return_value=rtcstats) as prepare:
        webdriver.Remote.return_value = driver
        session.run()
    return webdriver, prepare


def test_a_session_joins_shows_the_menu_and_relays_until_it_stops(monkeypatch):
    monkeypatch.setenv("GW_NAME", "gw1")
    session = new_session()
    steps, pairings, driver = running(session, loops=2)
    webdriver, prepare = run_session(session, driver, rtcstats=True)

    prepare.assert_called_once_with(session.chromeOptions, "gw1", "room1", "fakeconnector")
    assert session.rtcstatsOn is True
    webdriver.Remote.assert_called_once_with(command_executor="http://127.0.0.1:9515", options=session.chromeOptions)
    names = [c[0] for c in steps.method_calls]
    assert names[:3] == ["loadPage", "join", "interact"]
    assert names[3:6] == ["monitorLeftMeeting", "loadImages", "loadJS"]
    assert names[6:] == ["checkStreamedSlide", "manageLayout", "interact"] * 2
    path, lang = steps.loadImages.call_args.args
    assert steps.loadImages.call_count == 1
    assert (os.path.normpath(path), lang) == (ASSETS, "en")
    assert os.path.normpath(steps.loadJS.call_args.args[0]) == os.path.join(ASSETS, "IVR", "menu.js")
    menu = [c.args[0] for c in driver.execute_script.call_args_list if "new Menu(" in c.args[0]]
    assert len(menu) == 1
    assert 'menu=new Menu([{"key": "1", "label": "Microphone"}], "en");' in menu[0]
    for part in ("menu.img['icon'] = 'ICON';", "menu.img['dtmf'] = 'DTMF';",
                 "menu.img['icons'] = {\"mic\": \"MIC\"};", "menu.show();"):
        assert part in menu[0]
    assert pairings == [driver] * 3


def test_the_session_waits_for_the_join_before_it_watches_the_meeting():
    session = new_session()
    steps, _, driver = running(session, joined=(False, False, False, True))
    run_session(session, driver)
    names = [c[0] for c in steps.method_calls]
    assert names[:6] == ["loadPage", "join", "interact", "interact", "interact", "monitorLeftMeeting"]


@pytest.mark.parametrize("timeout, expected", [(None, []), ("120", [call(120, checkInterval=60)])])
def test_the_alone_timeout_is_watched_only_when_set(monkeypatch, timeout, expected):
    if timeout:
        monkeypatch.setenv("ENDING_TIMEOUT", timeout)
    session = new_session()
    steps, _, driver = running(session)
    run_session(session, driver)
    assert steps.monitorSingleParticipant.call_args_list == expected


def test_a_session_error_is_reported_not_raised(capsys):
    session = new_session()
    steps, _, _ = running(session)
    with patch.object(browsing_module, "webdriver") as webdriver, \
            patch.object(browsing_module.rtcstatsTrace, "prepare", return_value=False):
        webdriver.Remote.side_effect = RuntimeError("no chromedriver")
        session.run()
    assert "Error while browsing: no chromedriver" in capsys.readouterr().out
    steps.join.assert_not_called()


# Stop

def stopped(session, rtcstats=False):
    driver = session.driver
    session.rtcstatsOn = rtcstats
    with patch.object(session, "unset") as unset, \
            patch.object(browsing_module.rtcstatsTrace, "close") as close:
        session.stop()
    return driver, unset, close


def test_stop_leaves_the_meeting_and_closes_the_browser(capsys):
    session = with_driver(new_session(), {"joined": True})
    driver, unset, close = stopped(session)
    unset.assert_called_once_with()
    assert driver.execute_script.call_args_list == [call("return window.meeting")]
    driver.close.assert_called_once_with()
    driver.quit.assert_called_once_with()
    close.assert_not_called()
    assert session.room == {} and session.name == ""
    assert "Browsing stopped" in capsys.readouterr().out


def test_stop_without_a_meeting_closes_the_browser_only():
    session = with_driver(new_session(), None)
    driver, unset, _ = stopped(session)
    unset.assert_not_called()
    driver.quit.assert_called_once_with()


def test_stop_closes_the_browser_after_a_page_error():
    session = with_driver(new_session())
    session.driver.execute_script.side_effect = RuntimeError("page gone")
    driver, unset, _ = stopped(session)
    unset.assert_not_called()
    driver.quit.assert_called_once_with()


def test_stop_sends_the_last_webrtc_statistics_before_it_closes():
    session = with_driver(new_session(), None)
    driver, _, close = stopped(session, rtcstats=True)
    close.assert_called_once_with(driver)
    assert session.rtcstatsOn is False
    driver.quit.assert_called_once_with()


def test_stop_without_a_browser_clears_the_session():
    session = new_session()
    stopped(session)
    assert session.room == {} and session.name == ""


def test_a_stop_error_is_reported_not_raised(capsys):
    session = with_driver(new_session(), None)
    session.driver.close.side_effect = RuntimeError("browser gone")
    stopped(session)
    assert "RuntimeError: browser gone" in capsys.readouterr().out
