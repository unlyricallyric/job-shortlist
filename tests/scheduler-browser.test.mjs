import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { cardsInPage, detailInPage, pageGuard, searchUrl } from "../scheduler/browser.mjs";

const evaluate = (fn, globals, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
  URL, Date, ...globals, args,
});
const location = new URL("https://www.zhipin.com/web/geek/jobs?query=渠道市场&city=101020100");
const visible = (innerText = "") => ({ innerText, getClientRects: () => [{}] });

test("Chinese searches have the exact city/industry restrictions and never an experience filter", () => {
  const url = new URL(searchUrl({ term: "市场活动", industry: "100021" }));
  assert.equal(url.origin, "https://www.zhipin.com");
  assert.equal(url.searchParams.get("city"), "101020100");
  assert.equal(url.searchParams.get("experience"), null);
  for (const query of [{ term: "Field Marketing" }, { term: "市场", industry: "123456" }, { term: "" }]) {
    assert.throws(() => searchUrl(query));
  }
});

test("public page guard rejects wrong host, stale query and explicit visible login/captcha states", () => {
  const document = { querySelectorAll: () => [] };
  assert.equal(evaluate(pageGuard, { document, location: new URL("https://example.invalid/") }).state, "blocked");
  assert.equal(evaluate(pageGuard, { document, location }, searchUrl({ term: "需求生成" })).state, "waiting");
  for (const [selector, code] of [[".captcha-box", "captcha"], [".sign-dialog", "login-required"]]) {
    const result = evaluate(pageGuard, {
      location, document: { querySelectorAll: (name) => name === selector ? [visible()] : [] },
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.code, code);
  }
});

test("card extraction never decodes private-use salary glyphs or reads recruiter details", () => {
  const make = (salary) => {
    const values = {
      ".boss-name": { innerText: "TEST_ONLY_COMPANY" },
      ".company-location": { innerText: "上海·TEST_ONLY" },
      ".job-salary": { innerText: salary },
    };
    return {
      href: "https://www.zhipin.com/job_detail/test-only.html?tracking=ignored",
      innerText: "市场经理",
      closest: () => ({
        querySelector: (selector) => {
          assert.ok(Object.hasOwn(values, selector), `Unexpected private selector: ${selector}`);
          return values[selector];
        },
        querySelectorAll: () => [{ innerText: "3-5年" }, { innerText: "本科" }],
      }),
    };
  };
  const result = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector === "a.job-name" ? [make("\ue123-\ue234K"), make("8-12K")] : [] },
  });
  assert.equal(result.cards[0].salaryText, null);
  assert.equal(result.cards[1].salaryText, "8-12K");
  assert.equal(result.cards[0].url, "https://www.zhipin.com/job_detail/test-only.html");
  assert.ok(!Object.hasOwn(result.cards[0], "salaryMinK"));
});

test("full JD requires both matching public ID and exact heading before acceptance", () => {
  const page = (id, title) => ({
    document: {
      querySelector: (selector) => ({
        ".job-detail-body a.more-job-btn": { href: `https://www.zhipin.com/job_detail/${id}.html` },
        ".job-detail-body .desc": { innerText: "TEST_ONLY_DESCRIPTION ".repeat(10) },
        ".job-detail-info": { innerText: `${title}\nTEST_ONLY` },
      })[selector],
    },
  });
  assert.equal(evaluate(detailInPage, page("a", "市场经理"), "boss-a", "市场经理").state, "ready");
  assert.equal(evaluate(detailInPage, page("stale", "市场经理"), "boss-a", "市场经理").state, "waiting");
  assert.equal(evaluate(detailInPage, page("a", "其他职位"), "boss-a", "市场经理").state, "waiting");
});

test("a legitimate empty result differs from an unknown or broken page", () => {
  assert.equal(evaluate(cardsInPage, { document: { querySelectorAll: () => [] } }).state, "waiting");
  const result = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector === "a.job-name" ? [] : [visible("没有找到相关职位")] },
  });
  assert.equal(result.state, "ready");
  assert.equal(result.empty, true);
});
