"""
The eduMEET connector and the eduMEET client agree on one event for the language
(edumeet:set-locale, AUTOMATION.md in the edumeet repository). The connector runs in the
browser; these checks pin the contract its source must keep.
"""
import os

SOURCE = os.path.join(os.path.dirname(__file__), "../../browsing/assets/edumeet.js")


def connector():
    with open(SOURCE, encoding="utf-8") as f:
        return f.read()


def test_the_language_goes_with_the_event_the_client_listens_for():
    assert "new CustomEvent('edumeet:set-locale', { detail: { locale: code } })" in connector()


def test_only_a_page_with_the_automation_attributes_gets_a_language():
    assert "!document.querySelector('[data-edumeet-control]')) return false;" in connector()
