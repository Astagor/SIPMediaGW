import os
import re

import pytest

pytestmark = pytest.mark.usefixtures("disable_proxy_monitor_gateways")

PAGES = os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "proxyAPI")


def referenced(page, prefix):
    with open(os.path.join(PAGES, page), encoding="utf-8") as f:
        html = f.read()
    return re.findall(r'(?:src|href)="(/' + prefix + r'/static/[^"]+)"', html)


@pytest.mark.parametrize("page, prefix", [("pairing.html", "pairing"), ("interact.html", "interact")])
def test_every_file_a_page_loads_is_served(client, page, prefix):
    files = referenced(page, prefix)
    assert any(path.endswith("/lang.js") for path in files)
    for path in files:
        assert client.get(path).status_code == 200, path
