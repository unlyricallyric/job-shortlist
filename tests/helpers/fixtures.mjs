// Isolated test fixtures are never included in the site's data.
export const fixture = (overrides = {}) => ({
  id: "boss-unit-test-only", title: "TEST_ONLY_TITLE", company: "TEST_ONLY_COMPANY",
  city: "上海", location: null, source: "BOSS直聘",
  url: "https://www.zhipin.com/job_detail/unit-test-only.html",
  salaryText: null, salaryMinK: null, salaryMaxK: null, salaryMonths: null,
  experienceText: null, educationText: null, category: "渠道销售", matchScore: 50,
  priority: "优先了解", summary: [], requirements: [], matchReasons: [], concerns: [],
  languageNote: null, publishedAt: null, firstSeen: "2026-09-07T08:00:00+08:00",
  lastSeen: "2026-09-07T09:00:00+08:00", jdRead: true, isNew: true, ...overrides,
});

export const snapshotOf = (jobs) => ({
  version: 1, generatedAt: "2026-09-07T12:00:00+08:00",
  run: {
    source: "BOSS直聘", scope: "TEST_ONLY_SCOPE", mode: "单次采集",
    cardsReviewed: jobs.length, detailsRead: jobs.filter((job) => job.jdRead).length,
    selectedCount: jobs.length, newCount: jobs.filter((job) => job.isNew).length,
  },
  jobs,
});
