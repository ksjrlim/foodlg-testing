"""End-to-end journey on a phone-sized screen, against a freshly seeded synthetic database.
Run: python3 tests/e2e.py  (app on http://localhost:3000, after npm run db:reset)
"""
import re, sys, os
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE", "http://localhost:3000")
SHOTS = os.environ.get("SHOTS", "/tmp/claude-0/shots")
os.makedirs(SHOTS, exist_ok=True)
results = []
UNVERIFIED = re.compile(r"\b\d+(\.\d+)?\s?(g|kcal|mg)\b(?! sugar per)", re.I)  # nutrient numbers in grams, kcal or mg

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)

def page_checks(page, label):
    # no horizontal scroll at phone width
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    check(f"{label}: no horizontal scroll at 390px", not overflow)
    # every form control has an accessible name
    unnamed = page.evaluate("""() => [...document.querySelectorAll('input:not([type=hidden]),select,button,textarea')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 || e.type === 'radio' || e.type === 'checkbox'; })
      .filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !(e.textContent||'').trim()).length""")
    check(f"{label}: every control has an accessible name", unnamed == 0)
    page.screenshot(path=f"{SHOTS}/{label}.png", full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    phone = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)

    # ---------- New patient P-0003: join, consent, choose, check in ----------
    ctx = browser.new_context(**phone); page = ctx.new_page()
    page.goto(f"{BASE}/join/invite-p-0003")
    page_checks(page, "01-join")
    page.fill("#passcode", "135790"); page.fill("#confirm", "135790")
    page.click("button[type=submit]")
    check("join without consent is refused", page.locator("input[name=consent]").is_visible())
    page.check("input[name=consent]"); page.click("button[type=submit]")
    page.wait_for_url(f"{BASE}/patient")
    check("joined and landed on patient home", "Pick the change that fits your life" in page.content())
    page.click("text=Choose my change"); page.wait_for_url(f"{BASE}/patient/choose")
    page_checks(page, "02-choose")
    body = page.inner_text("main")
    check("choose shows only pre-approved options (kopi siu dai, water)", "Kopi siu dai" in body and "Plain water" in body and "Teh siu dai" not in body)
    check("published claim is labelled HealthHub with a stall note", "HealthHub standard drink" in body and "preparation may differ" in body)
    check("no unverified nutrient numbers on choose screen", not UNVERIFIED.search(body))
    # mark kopi siu dai as not available at the stall: it should drop below and become not possible
    card = page.locator(".card", has_text="Kopi siu dai").first
    card.locator("label", has_text="No").first.click()
    first_title = page.locator(".card h3").first.inner_text()
    check("ranking re-orders live: unavailable option drops below", "Plain water" in first_title)
    page.click("button[type=submit]:has-text('Start 7 days')")
    page.wait_for_url(f"{BASE}/patient")
    page_checks(page, "03-checkin")
    check("cycle started with water", "My 7 days: Plain water instead" in page.content())
    page.click("text=Yes, I had plain water instead")
    page.wait_for_load_state()
    check("followed check-in recorded", "All done for today" in page.content())
    ctx.close()

    # ---------- Existing patient P-0001: usual drink → taste barrier → automatic switch ----------
    ctx = browser.new_context(**phone); page = ctx.new_page()
    page.goto(f"{BASE}/patient/login"); page.fill("#code", "P-0001"); page.fill("#passcode", "000000"); page.click("button[type=submit]")
    page.wait_for_selector("[role=alert]")
    check("wrong passcode is refused", "don't match" in page.content())
    page.fill("#passcode", "246810"); page.click("button[type=submit]"); page.wait_for_url(f"{BASE}/patient")
    week_text = page.inner_text(".week")
    check("week shows no-opportunity and no-entry days distinctly", "None" in week_text and "No entry" in week_text)
    page.click("text=I had my usual drink instead"); page.wait_for_url(re.compile(r"/patient/adapt"))
    page_checks(page, "04-barriers")
    check("barriers grouped as personal, social, environmental", all(x in page.content() for x in ["Personal", "Social", "Environmental"]))
    page.click("text=I didn't like the taste"); page.wait_for_url(re.compile(r"b=taste"))
    page_checks(page, "05-response")
    check("taste on a big step suggests a smaller pre-approved step", "Switch to Kopi siu dai" in page.content())
    page.click("text=Switch to Kopi siu dai"); page.wait_for_url(re.compile(r"/patient"))
    check("switch applied automatically, starting tomorrow", "Your new change starts tomorrow" in page.content())
    ctx.close()

    # ---------- Patient P-0002: switch outside pre-approved list becomes a request ----------
    ctx = browser.new_context(**phone); page = ctx.new_page()
    page.goto(f"{BASE}/patient/login"); page.fill("#code", "P-0002"); page.fill("#passcode", "246810"); page.click("button[type=submit]"); page.wait_for_url(f"{BASE}/patient")
    page.click("text=I had my usual drink instead"); page.wait_for_url(re.compile(r"/adapt"))
    page.click("text=My usual stall couldn't make it"); page.wait_for_url(re.compile(r"b=stall_cant"))
    check("outside-plan suggestion is shown as a request, not applied", "won't change it on its own" in page.content())
    page.click("text=Ask my dietitian about Plain water instead"); page.wait_for_url(re.compile(r"/patient"))
    check("patient told the dietitian will decide", "Nothing changes until they agree" in page.content())
    ctx.close()

    # ---------- Dietitian A: flags, summary, approve ----------
    ctx = browser.new_context(**phone); page = ctx.new_page()
    page.goto(f"{BASE}/login"); page.fill("#email", "dietitian.a@example.test"); page.fill("#password", "demo-password-1"); page.click("button[type=submit]")
    page.wait_for_url(f"{BASE}/dietitian")
    page_checks(page, "06-dietitian-home")
    home = page.inner_text("main")
    check("dietitian A sees only own patients", "P-0001" in home and "P-0101" not in home)
    check("awaiting requests are flagged", "awaiting your decision" in home)
    page.click("a:has-text('P-0002')"); page.wait_for_url(re.compile(r"/dietitian/patients/"))
    page_checks(page, "07-summary")
    s = page.inner_text("main")
    check("summary explains data gaps are not adherence", "data gaps" in s.lower())
    page.click("button:has-text('Approve')"); page.wait_for_load_state()
    check("approval creates plan version 2", "plan version 2" in page.inner_text("main"))
    # isolation by URL: try dietitian B's patient
    pid_b = os.environ.get("PID_B")
    if pid_b:
        r = page.goto(f"{BASE}/dietitian/patients/{pid_b}")
        check("another dietitian's patient URL returns not found", r.status == 404)
    ctx.close()

    # ---------- Patient cannot reach dietitian pages; admin metrics ----------
    ctx = browser.new_context(**phone); page = ctx.new_page()
    page.goto(f"{BASE}/dietitian"); check("unauthenticated dietitian page redirects to sign-in", page.url.endswith("/login"))
    r = page.goto(f"{BASE}/dietitian/export?table=checkins&mode=synthetic"); check("export refused without admin", r.status == 403)
    page.goto(f"{BASE}/login"); page.fill("#email", "admin@example.test"); page.fill("#password", "demo-password-1"); page.click("button[type=submit]"); page.wait_for_url(f"{BASE}/dietitian")
    page.goto(f"{BASE}/dietitian/metrics")
    page_checks(page, "08-metrics")
    m = page.inner_text("main")
    check("metrics separate behaviour from engagement", "Behaviour-change outcomes" in m and "not evidence of behaviour change" in m)
    with page.expect_download() as d:
        page.click("a:has-text('checkins.csv')")
    csv = open(d.value.path()).read()
    check("export downloads with patient codes only", csv.startswith("patient_code,") and not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", csv))
    ctx.close()
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
