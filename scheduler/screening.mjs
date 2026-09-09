const CAPABILITIES = new Set([
  "b2bMarketing", "partnerMarketing", "fieldEvents", "demandGeneration",
  "marketingOps", "customerSuccess", "partnerDevelopment", "productMarketing",
  "brandEvents", "contentSeo", "portfolio", "aiTools", "teamLeadership",
  "budgetOwnership", "closingSales", "pricingStrategy", "isvEngineering",
  "technicalDevelopment",
]);
const YEAR_KEYS = ["marketing", "b2b", "partner", "events", "management", "technical"];
const EDUCATION = new Map([[null, null], ["bachelor", 1], ["master", 2], ["doctor", 3]]);
const ROLE_DEFINITIONS = [
  ["区域市场", "fieldEvents", "marketing", "区域市场活动", /(?:区域|华东|大区|本地|regional|field).{0,18}(?:市场|营销|marketing)|(?:field|regional) marketing/u],
  ["伙伴营销", "partnerMarketing", "marketing", "合作伙伴联合营销", /联合(?:营销|市场|推广|活动|gtm)|联合举办(?:研讨会|论坛|活动)|伙伴营销|渠道市场|生态市场|市场赋能|伙伴赋能|co[- ]?marketing|partner marketing|channel marketing/u],
  ["需求生成", "demandGeneration", "marketing", "获客、线索培育与商机漏斗", /需求生成|线索(?:生成|获取|培育|孵化|转化|运营)|获客(?:营销|活动|策略)|demand gen(?:eration)?|mql|sales[- ]qualified leads?|营销漏斗|商机管道|marketing pipeline|pipeline (?:marketing|generation)|(?:营销|销售|商机|线索).{0,8}pipeline/u],
  ["伙伴发展", "partnerDevelopment", "partner", "合作伙伴拓展与发展", /(?:拓展|招募|引入|开发|发展|建立).{0,12}(?:合作伙伴|生态伙伴|渠道伙伴|伙伴网络)|partner development/u],
  ["生态商业化", "partnerDevelopment", "partner", "生态合作与商业落地", /生态商业化|生态变现|(?:生态|伙伴).{0,16}(?:商业落地|商业模式|联合解决方案商业化)/u],
  ["销售开发", "demandGeneration", "b2b", "潜在客户开发与商机初筛", /商机(?:挖掘|初筛|筛选|资格评估)|开发潜在客户|潜在客户开发|sales development|\bsdr\b|\bbdr\b/u],
  ["销售运营", "marketingOps", "b2b", "销售流程与运营分析", /销售运营|销售流程|销售漏斗分析|crm(?:系统)?(?:运营|管理)|sales operations|\brevops\b/u],
  ["客户成功", "customerSuccess", "b2b", "客户使用、成功与留存", /客户成功|客户健康|客户留存|客户使用.{0,10}(?:提升|落地)|(?:客户|存量).{0,10}(?:续约|增购)|customer success|customer onboarding/u],
  ["产品市场", "productMarketing", "marketing", "产品定位与上市推广", /产品(?:市场|营销|定位)|价值主张|上市(?:推广|策略|计划)|product marketing|product positioning|go[- ]to[- ]market/u],
  ["品牌活动", "brandEvents", "events", "品牌传播与活动执行", /品牌(?:活动|传播|推广)|活动(?:策划|营销)|event marketing|brand events?/u],
  ["渠道销售", "closingSales", "partner", "渠道销售与成交", /渠道销售|分销销售|channel sales/u],
  ["大客户销售", "closingSales", "b2b", "企业客户销售与成交", /大客户销售|企业客户销售|account executive|key account sales/u],
].map(([category, capability, years, concept, pattern]) => ({ category, capability, years, concept, pattern }));
const DIRECTIONS = new Set(ROLE_DEFINITIONS.map(({ category }) => category));
const PARTNER = /合作伙伴|渠道|伙伴|生态伙伴|\bpartners?\b|\bisv\b|代理商|经销商/u;
const BUSINESS = /b2b|to[ -]?b|企业级|企业客户|企业软件|企业服务|云计算|云服务|公有云|saas|软件服务|\bisv\b/u;
const UNRELATED_DUTY = /仓库(?:收货|拣货|盘点|分拣)|货物盘点|货车驾驶|门店收银|患者护理|病房护理|烹饪菜肴|清扫保洁|会计核算|财务报税|薪酬核算/u;
const ACTION = /负责|开展|推动|制定|规划|策划|执行|组织|设计|搭建|管理|运营|拓展|建立|维护|开发|提升|完成|承担|统筹|主导|落地|输出|制作|参与|协同|配合|deliver|develop|manage|own|drive|build|plan|execute|lead|support|create/u;
const COLLABORATION = /协作|协同|协调|配合|协助|对接|联动|(?:与|和).{0,12}合作|collaborat|support|work with/u;
const OWNERSHIP = /独立|主导|全面负责|直接负责|承担|统筹|审批|决策|own(?:ership|ing)?|accountable/u;
const LEAD_SQL = /mql.{0,20}sql|sql.{0,20}mql|sales[- ]qualified leads?|销售合格线索|销售认可线索/u;
const CODE = /(?:编写|编程|开发|执行|优化).{0,12}(?:代码|sql(?:语句|查询)?|程序|脚本)|sql.{0,12}(?:编程|查询|数据库)|(?:精通|掌握|熟练使用).{0,8}(?:python|java\b|c\+\+|verilog|vhdl|编程)|(?:fpga|芯片|硬件|软件|嵌入式)(?:的|产品|系统|平台)?(?:研发|开发|电路设计)|isv(?:研发|开发)经验|软件工程|coding|software development|fpga (?:r&d|development)|write.{0,10}code/u;
const MANAGEMENT = /团队管理|团队领导|人员管理|员工管理|直属下属|(?:带领|管理|领导).{0,8}(?:团队|员工|下属)|(?:带领|管理|领导).{0,6}[0-9一二两三四五六七八九十百]+(?:人|名)|people management|team (?:management|leadership)|manage.{0,10}(?:employees|direct reports|a team)|lead.{0,12}(?:marketing|sales) team/u;
const PORTFOLIO = /作品集|\bportfolio\b|(?:提供|提交|展示|出示|附上|递交|携带).{0,12}(?:作品|案例)/u;
const PRICING = /定价(?:架构|体系|策略|模型)|价格(?:架构|体系|策略|模型)|pricing (?:architecture|strategy|ownership)/u;
const SEO = /\bseo\b|搜索引擎优化/u;
const REVENUE = /销售(?:额|业绩|收入)?(?:指标|目标)|(?:营收|销售额|回款).{0,12}(?:指标|目标|任务)|对.{0,8}(?:收入|营收|销售额|回款).{0,4}负责|个人.{0,8}(?:签单|成交|销售额)|独立(?:签单|成交)|负责签单|客户合同签约|销售合同.{0,8}(?:签约|成交)|sales quota|revenue target|close deals|closed[- ]won/u;
const PREFERRED = /优先|加分|非必需|非必备|不做硬性要求|\bpreferred\b|nice[- ]to[- ]have|\ba plus\b|\bbonus\b/u;
const MUST = /必须|必需|必备|硬性|不可缺少|\bmust\b|\brequired\b/u;
const NO_REQUIREMENT = /不(?:做|作)?要求|无需|无须|不需(?:要)?|不涉及|经验不限|学历不限|专业不限|不限经验|不限学历|no experience required|not required/u;
const IGNORED = /英语|英文|外语|工作语言|双语|国际团队|\benglish\b|\blanguage\b|雅思|托福|cet[- ]?[46]|ielts|toefl|专四|专八|英语?[四六]级|年龄|性别|婚姻|婚育|已婚|未婚|已育|未育|生育|家庭状况|男女不限|男性|女性|限男|限女|男士|女士|[0-9一二两三四五六七八九十]+(?:周岁|岁)/u;
const SOFT_SKILL = /沟通|协作|协同|团队合作|合作意识|执行力|学习能力|责任心|自驱|抗压|逻辑思维|分析能力|表达能力|项目推进|项目管理|跨部门|communication|teamwork/u;
const UNSUPPORTED_REQUIREMENT = /(?:相关|计算机|电子|通信|理工|工科|金融|医学|市场营销|管理学|新闻|广告).{0,8}专业|专业背景|全日制|统招|985|211|双一流|博士后|mba|证书|认证资格|执照|许可证|持证|资格证|留学|海外经历|海外经验|世界.?500强|五百强|头部公司|大型企业|上市公司经验|外企经验|出差|搬迁|驻场|轮班|驾照|工作许可|签证|(?:丰富|多年|资深|深厚|长期).{0,10}(?:经验|经历|积累)|数年|若干年|多年|extensive experience|several years|many years|(?:已有|自带|拥有|积累).{0,12}(?:客户|人脉|政府|渠道)资源/u;
const BUSINESS_SCALE = /[0-9零〇一二两三四五六七八九十百千万亿]+(?:\.[0-9]+)?\s*(?:(?:人|名).{0,10}(?:团队|员工|下属|专员)|人以上|万元|亿元|万预算|亿预算|%|家客户|场活动)|(?:团队|员工|下属).{0,8}[0-9一二两三四五六七八九十百]+(?:人|名)|(?:百|千|万|亿)+(?:元|级)?(?:预算|市场预算|年度预算)/u;
const BUDGET_AMOUNT = /[0-9一二两三四五六七八九十百千万亿]+(?:\.[0-9]+)?\s*(?:万|亿|元|million|billion)|千万|百万|亿级/u;
const CONTACT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}|\b\d{3}[- ]\d{3}[- ]\d{4}\b|微信号|wechat|联系方式|联系电话|(?:电话|手机|qq|邮箱|联系人|简历|微信|vx|wx|e[- ]?mail|recruiter)\s*[：:]|https?:\/\//iu;
const OTHER_LOCATION = /北京|深圳|广州|杭州|苏州|南京|成都|重庆|武汉|西安|天津|合肥|宁波|无锡|厦门|福州|济南|青岛|郑州|长沙|东莞|佛山|珠海|大连|沈阳|长春|哈尔滨|昆明|南宁|贵阳|南昌|太原|石家庄|兰州|乌鲁木齐|海口|三亚|香港|澳门|台湾|浙江|江苏|广东|福建|山东|四川|湖北|湖南|安徽|河南|河北|海外|新加坡|东京|london|beijing|shenzhen|guangzhou|hangzhou|singapore/u;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百壹贰貳叁參肆伍陆陸柒捌玖拾佰兩]+)`;
const YEAR_PATTERN = new RegExp(`(${NUMBER})(?:\\s*(?:[-–—~～至到]|to)\\s*(${NUMBER}))?\\s*\\+?\\s*(?:年|years?\\b)`, "gu");

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  return plainObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function configError(condition, detail) {
  if (!condition) throw new TypeError(`Invalid matching config: ${detail}.`);
}

export function validateMatchingConfig(config) {
  configError(exactKeys(config, ["version", "directions", "confirmedCapabilities", "years", "education"]), "expected only version, directions, confirmedCapabilities, years and education");
  configError(config.version === 1, "version must be 1");
  for (const [key, allowed] of [["directions", DIRECTIONS], ["confirmedCapabilities", CAPABILITIES]]) {
    const values = config[key];
    configError(Array.isArray(values) && Array.from(values).every((value) => allowed.has(value)), `${key} must contain only supported identifiers`);
    configError(new Set(values).size === values.length, `${key} must not contain duplicates`);
  }
  configError(config.directions.length > 0, "directions must not be empty");
  configError(exactKeys(config.years, YEAR_KEYS), "years must contain exactly the six supported dimensions");
  for (const key of YEAR_KEYS) {
    const value = config.years[key];
    configError(value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0), `years.${key} must be null or a finite nonnegative number`);
  }
  configError(EDUCATION.has(config.education), "education must be null, bachelor, master or doctor");
  return config;
}

function normalize(text) {
  return text.normalize("NFKC").toLowerCase().trim();
}

function safeMetadata(value, limit) {
  return value === undefined || value === null || (typeof value === "string"
    && value.trim().length > 0 && value.length <= limit
    && !/[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\ufffd]/u.test(value) && !CONTACT.test(normalize(value))
    && !/岗位职责|工作职责|职位描述|任职要求|职位要求|岗位要求|任职资格/u.test(normalize(value)));
}

function geography(value) {
  if (!value) return "unknown";
  const text = normalize(value);
  if (/非上海|不含上海|不在上海|上海(?:以外|除外)|除上海|上海周边|上海附近|环上海/u.test(text)) return "other";
  if (/上海|\bshanghai\b/u.test(text)) return "shanghai";
  return OTHER_LOCATION.test(text) ? "other" : "unknown";
}

function unrelatedTitle(title) {
  const text = normalize(title ?? "");
  if (/实习(?!项目)|在校生|学生兼职|校园招聘|校招专岗|仅限应届|intern(?:ship)?\b/u.test(text)) return "student-only";
  const businessTitle = /市场|营销|品牌|活动|渠道|伙伴|生态|商务|客户|销售|产品经理|marketing|partner|business|sales|success/u.test(text);
  if (!businessTitle && /(?:研发|开发|软件|硬件|算法|运维|测试|嵌入式|fpga|芯片|前端|后端|全栈).{0,8}(?:工程师|程序员)|software engineer|developer|护士|厨师|保安|货运司机|仓库管理员/u.test(text)) return "role-unrelated";
  return null;
}

function inspectCard(card) {
  if (!plainObject(card) || typeof card.id !== "string" || !/^boss-[A-Za-z0-9_~-]+$/u.test(card.id) || /[\r\n]/u.test(card.id)
    || card.id.length > 220 || card.url !== `https://www.zhipin.com/job_detail/${card.id.slice(5)}.html`) {
    return { eligible: false, reason: "card-identity-invalid" };
  }
  for (const [key, limit] of [["title", 180], ["company", 180], ["location", 160], ["experienceText", 100], ["educationText", 100]]) {
    if (!safeMetadata(card[key], limit)) return { eligible: false, reason: "card-metadata-invalid" };
  }
  if (geography(card.location) === "other") return { eligible: false, reason: "geography-outside-shanghai" };
  const unrelated = unrelatedTitle(card.title);
  return unrelated ? { eligible: false, reason: unrelated } : { eligible: true, reason: "full-jd-required" };
}

export function prefilterCard(card, config) {
  validateMatchingConfig(config);
  return inspectCard(card);
}

export function cardReadPriority(card, config) {
  const title = normalize(card.title ?? "");
  const signals = [
    ["partnerMarketing", /渠道市场|伙伴营销|渠道营销|生态市场|联合营销/u],
    ["fieldEvents", /市场活动|区域市场|活动营销|会展/u],
    ["demandGeneration", /需求生成|增长|市场推广|获客/u],
    ["marketingOps", /营销运营|销售运营|线索运营/u],
    ["customerSuccess", /客户成功/u],
    ["partnerDevelopment", /伙伴发展|伙伴拓展|生态合作/u],
    ["productMarketing", /产品市场|产品营销/u],
    ["brandEvents", /品牌活动|品牌营销/u],
  ];
  if (signals.some(([capability, pattern]) => config.confirmedCapabilities.includes(capability) && pattern.test(title))) return 2;
  return /市场|营销|活动|品牌|运营/u.test(title) ? 1 : 0;
}

function fullTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || match[0] !== value) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days[Number(month) - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (offset === "Z" || (Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4)) < 60))
    && Number.isFinite(Date.parse(value));
}

const DUTY_HEADINGS = ["岗位职责", "工作职责", "职位描述", "岗位基本描述", "岗位描述", "工作内容", "职责描述", "职位职责"];
const REQUIREMENT_HEADINGS = ["任职要求", "职位要求", "岗位要求", "任职资格", "任职条件", "希望你具备能力", "希望你具备的能力", "我们希望你具备"];
const PREFERRED_HEADINGS = ["加分技能", "加分项", "优先条件", "优先要求"];
const REQUIRED_HEADINGS = ["必备条件", "基本要求", "必要条件", "硬性要求"];
const SECTION_ENDINGS = ["福利待遇", "薪资福利", "职位福利", "公司介绍", "公司简介", "关于我们", "联系方式", "工作地点"];

export function parseJobSections(record) {
  const parts = { duties: [], requirements: [] };
  const text = record.jd.normalize("NFKC").replace(/[\u2028\u2029]/gu, "\n");
  const names = [...DUTY_HEADINGS, ...REQUIREMENT_HEADINGS, ...PREFERRED_HEADINGS, ...REQUIRED_HEADINGS, ...SECTION_ENDINGS].join("|");
  const heading = new RegExp(`(?:^|[\\r\\n。；;])[\\t ]*(?:[-*•][\\t ]*)?(?:[一二三四五六七八九十\\d]+[、.)-][\\t ]*)?[【[(]?[\\t ]*(${names})[\\t ]*[】\\])]?[\\t ]*(?:[:：][\\t ]*|(?=\\r?\\n|$))`, "gu");
  const matches = [...text.matchAll(heading)];
  for (const [index, match] of matches.entries()) {
    const name = match[1];
    const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim();
    if (DUTY_HEADINGS.includes(name)) parts.duties.push(body);
    else if (REQUIREMENT_HEADINGS.includes(name) || REQUIRED_HEADINGS.includes(name)) {
      parts.requirements.push(`必备条件：\n${body}`);
    } else if (PREFERRED_HEADINGS.includes(name)) parts.requirements.push(`加分项：\n${body}`);
  }
  const first = matches[0];
  if (!parts.duties.length && first && REQUIREMENT_HEADINGS.includes(first[1])) {
    const prefix = text.slice(0, first.index).trim();
    const lines = prefix.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const numbered = /^[\t ]*\d+[、.)-]\s*(.+)$/u;
    // Only a clearly numbered, action-led block before explicit requirements is a duty section.
    if (lines.length >= 2 && lines.every((line) => numbered.test(line))) {
      const items = lines.map((line) => numbered.exec(line)[1]);
      const duties = items.filter((item) => ACTION.test(normalize(item)) && !PREFERRED.test(normalize(item))
        && !/^(?:必须|需(?:要)?|须|具备|具有|熟悉|精通|本科|硕士|博士)/u.test(item));
      if (duties.length >= 2) {
        parts.duties.push(duties.join("\n"));
        for (const item of items) {
          if (!duties.includes(item) || /经验|经历|学历|具备|必须|要求/u.test(item)) {
            parts.requirements.unshift(`必备条件：\n${item}`);
          }
        }
      }
    }
  }
  for (const [key, type] of [["responsibilitiesText", "duties"], ["requirementsText", "requirements"]]) {
    if (record[key] !== undefined && record[key] !== null) {
      if (typeof record[key] !== "string" || record[key].length > 60000) return null;
      if (record[key].trim()) parts[type].push(record[key].normalize("NFKC").replace(/[\u2028\u2029]/gu, "\n"));
    }
  }
  return { duties: parts.duties.join("\n").trim(), requirements: parts.requirements.join("\n").trim() };
}

function clauses(text) {
  const result = [];
  let preferredBlock = false;
  const separated = normalize(text).replace(
    /\(\s*(学历不限|不限学历|专业不限|不限专业|经验不限|不限经验)\s*\)/gu, ";$1;");
  for (let line of separated.split(/[\r\n。；;]+/u)) {
    line = line.replace(/^\s*(?:[-*•]|\d+[、)）]|\d+-(?!\d)|\d+\.(?!\d))\s*/u, "").trim();
    if (/^(?:加分技能|加分项|优先条件|优先要求|preferred qualifications|nice[- ]to[- ]have)\s*[:：]?/u.test(line)) {
      preferredBlock = true;
      line = line.replace(/^(?:加分技能|加分项|优先条件|优先要求|preferred qualifications|nice[- ]to[- ]have)\s*[:：]?/u, "");
    } else if (/^(?:必备条件|基本要求|必要条件|硬性要求|required qualifications)\s*[:：]?/u.test(line)) {
      preferredBlock = false;
      line = line.replace(/^(?:必备条件|基本要求|必要条件|硬性要求|required qualifications)\s*[:：]?/u, "");
    }
    for (const part of line.split(/[，,]|但是|然而|并且|以及|同时|只需|但|且|并(?!购|行)|和|\band\b|\bbut\b|\bhowever\b/gu)) {
      const value = part.trim();
      if (!value) continue;
      const preferred = preferredBlock || PREFERRED.test(value);
      const positive = value.replace(/非必需|非必备|不做硬性要求|not required/gu, "");
      const exemption = NO_REQUIREMENT.test(value);
      const wholeExemption = /^(?:学历不限|不限学历|专业不限|不限专业|经验不限|不限经验|no experience required|not required)$/u.test(value);
      const leadingNegation = /^(?:不(?:做|作)?要求|无需|无须|不需(?:要)?|不涉及)/u.test(value);
      const ambiguousNegation = exemption && !wholeExemption
        && (!leadingNegation || MUST.test(value) || /须有|需有|具备|具有|至少|不少于|还需|仍需/u.test(value));
      result.push({
        text: value, preferred, conflict: (preferred && MUST.test(positive)) || ambiguousNegation,
        negated: exemption && !ambiguousNegation,
      });
    }
  }
  return result;
}

function engineering(text) {
  if (COLLABORATION.test(text) && !OWNERSHIP.test(text) && !/编写|编程|掌握|精通|熟练|熟悉|必须|需具备/u.test(text)) return false;
  return CODE.test(text) || (/\bsql\b/u.test(text) && !LEAD_SQL.test(text) && /熟悉|掌握|使用|精通|required|programming/u.test(text));
}

function ownsRevenue(text) {
  if (/跟踪|监测|分析|报表|报告/u.test(text) && !/承担|达成|完成|签约|成交/u.test(text) && !OWNERSHIP.test(text)) return false;
  return REVENUE.test(text) && (!COLLABORATION.test(text) || OWNERSHIP.test(text));
}

function majorBudget(text) {
  if (!/预算|budget/u.test(text)) return false;
  if (COLLABORATION.test(text) && !OWNERSHIP.test(text)) return false;
  if (/预算(?:跟踪|跟进|记录|核对|报销|执行)/u.test(text) && !/年度|整体|重大|大额|审批|决策|独立负责/u.test(text)) return false;
  return /预算.{0,12}(?:管理|审批|决策|分配|统筹|责任|负责|所有权)|(?:负责|管理|统筹|审批|掌控|制定|拥有|承担).{0,16}预算|budget ownership|own.{0,12}budget/u.test(text);
}

function engineeringResources(text) {
  if (/公司.{0,6}提供|现有研发团队/u.test(text) && !/自带|必须具备|需具备|自有/u.test(text)) return false;
  if (COLLABORATION.test(text) && !/自带|已有|拥有|自有|可调动|能调动|可调用|(?:工程|研发|开发|交付)资源/u.test(text)) return false;
  return /(?:自带|已有|拥有|具备|提供|可调动|能调动|可调用|自有|^有|须有|需有).{0,24}(?:工程|研发|开发|交付).{0,8}(?:资源|团队)(?!培训|赋能|材料|内容|支持)/u.test(text);
}

function dutyRoles(duties) {
  const active = duties.filter(({ preferred, negated }) => !preferred && !negated);
  const text = active.map(({ text: value }) => value).join("\n");
  const closing = active.some(({ text: value }) => ownsRevenue(value));
  let roles = ROLE_DEFINITIONS.filter((role) => active.some(({ text: value }) =>
    ACTION.test(value) && role.pattern.test(value)
    && (role.category !== "伙伴营销" || PARTNER.test(text))
    && (role.category !== "生态商业化" || BUSINESS.test(text))));
  // A closed-revenue remit is not relabelled as partner marketing or lead generation.
  if (closing) {
    const category = PARTNER.test(text) ? "渠道销售" : "大客户销售";
    roles = [ROLE_DEFINITIONS.find((role) => role.category === category)];
  }
  return { roles, text, closing };
}

function capabilityRequirements(text, role, duty = false) {
  const found = new Set();
  const independent = !COLLABORATION.test(text) || OWNERSHIP.test(text);
  if (MANAGEMENT.test(text)) found.add("teamLeadership");
  if (majorBudget(text)) found.add("budgetOwnership");
  if (PORTFOLIO.test(text)) found.add("portfolio");
  const seoCollaboration = /(?:与|协同|协作|配合|协助|对接).{0,10}(?:seo|搜索引擎优化)(?:团队|部门|人员|同事)/u.test(text) && !OWNERSHIP.test(text);
  if (SEO.test(text) && !seoCollaboration && (!duty || /负责|主导|独立|执行|优化|own|manage/u.test(text))) found.add("contentSeo");
  if (PRICING.test(text) && independent && (!duty || ACTION.test(text))) found.add("pricingStrategy");
  if (engineeringResources(text)) found.add("isvEngineering");
  if (engineering(text)) found.add("technicalDevelopment");
  if (ownsRevenue(text)) found.add("closingSales");
  if (!duty) {
    if (BUSINESS.test(text)) found.add("b2bMarketing");
    if (role.pattern.test(text) || /市场(?:营销)?经验|营销经验|相关(?:工作)?经验/u.test(text)) found.add(role.capability);
    if (/市场活动|会展|field events|field marketing/u.test(text)) found.add("fieldEvents");
    if (/联合营销|伙伴营销|渠道市场|partner marketing/u.test(text)) found.add("partnerMarketing");
    if (/伙伴拓展|伙伴招募|partner development/u.test(text)) found.add("partnerDevelopment");
    if (/需求生成|线索培育|mql|sales[- ]qualified leads?|demand generation/u.test(text)) found.add("demandGeneration");
    if (/crm|营销自动化|销售运营|漏斗分析|marketing operations|\brevops\b/u.test(text)) found.add("marketingOps");
    if (/客户成功|客户留存|customer success/u.test(text)) found.add("customerSuccess");
    if (/产品定位|产品营销|产品市场|product marketing/u.test(text)) found.add("productMarketing");
    if (/品牌活动|品牌传播/u.test(text)) found.add("brandEvents");
    if (/ai工具|ai辅助|生成式ai|aigc|人工智能工具|ai tools/u.test(text)) found.add("aiTools");
  }
  return found;
}

function chineseNumber(value) {
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  const formal = { 壹: "一", 贰: "二", 貳: "二", 叁: "三", 參: "三", 肆: "四", 伍: "五", 陆: "六", 陸: "六", 柒: "七", 捌: "八", 玖: "九", 拾: "十", 佰: "百", 兩: "两" };
  value = value.replace(/[壹贰貳叁參肆伍陆陸柒捌玖拾佰兩]/gu, (char) => formal[char]);
  if (!/^(?:[零〇一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九]百(?:[零〇]?[一二三四五六七八九]|[一二三四五六七八九]十[一二三四五六七八九]?)?)$/u.test(value)) return null;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, digit = 0;
  for (const char of value) {
    if (char === "十" || char === "百") {
      total += (digit || 1) * (char === "十" ? 10 : 100);
      digit = 0;
    } else digit = digits[char];
  }
  return total + digit;
}

function yearDimension(text, fallback) {
  for (const [key, pattern] of [
    ["management", MANAGEMENT],
    ["technical", /研发|开发|编程|工程|coding|engineering/u],
    ["partner", /伙伴|渠道|生态|partner|channel/u],
    ["events", /活动|会展|会议|events?/u],
    ["b2b", BUSINESS],
    ["marketing", /市场|营销|marketing/u],
  ]) if (pattern.test(text)) return key;
  return fallback;
}

function checkYears(text, config, state, fallback, implicit = false) {
  const matches = [...text.matchAll(YEAR_PATTERN)];
  if (!implicit && !/经验|经历|从业|任职|工作年限|experience|years?\b/u.test(text) && !MANAGEMENT.test(text)) return 0;
  for (const [index, match] of matches.entries()) {
    const minimum = chineseNumber(match[1]), upper = match[2] ? chineseNumber(match[2]) : null;
    if (minimum === null || !Number.isFinite(minimum) || (match[2] && (upper === null || !Number.isFinite(upper) || upper < minimum))) {
      state.review.add("years-ambiguous");
      continue;
    }
    const before = text.slice(index ? matches[index - 1].index + matches[index - 1][0].length : 0, match.index);
    const after = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).split(/经验|经历|experience/u)[0];
    const context = before + after;
    const unsupportedDimension = /seo|搜索引擎优化|预算管理|定价|pricing|销售运营|客户成功|客户留存|customer success|sales operations|项目管理/u.test(context)
      || (/管理|management/u.test(context) && !MANAGEMENT.test(context));
    if (unsupportedDimension || /近\s*$|最近|过去|连续/u.test(before) || /^(?:多|余)/u.test(after) || /或|或者|\bor\b/u.test(context)) {
      state.review.add("years-ambiguous");
      continue;
    }
    const dimension = yearDimension(after, yearDimension(before, fallback));
    const value = config.years[dimension];
    const bound = before.replace(/不少于|不小于|no less than|not less than/gu, "");
    const maximumOnly = /不超过|不能超过|不得超过|不多于|最多|至多|不满|少于|小于|不足|at most|less than|(?:no|not) more than/u.test(bound) || /^(?:以下|以内|及以下)/u.test(after);
    const exclusiveMaximum = /不满|少于|小于|不足|less than/u.test(bound);
    const exclusive = /(?:超过|多于|大于|more than|over)\s*$/u.test(before) && !maximumOnly;
    if (value === null || value === undefined) state.review.add("years-unconfirmed");
    else if ((maximumOnly && (exclusiveMaximum ? value >= minimum : value > minimum)) || (!maximumOnly && (exclusive ? value <= minimum : value < minimum))) state.reject.add("years-insufficient");
  }
  return matches.length;
}

function checkEducation(text, config, state, implicit = false) {
  const levels = [
    [3, /博士|doctor(?:ate|al)?|ph\.?d/u],
    [2, /硕士|master'?s?/u],
    [1, /本科|学士|bachelor'?s?/u],
    [0, /大专|专科|高中|中专/u],
  ].filter(([, pattern]) => pattern.test(text)).map(([level]) => level);
  if (!levels.length || (!implicit && !/学历|学位|毕业|本科|学士|硕士|博士|大专|专科|bachelor|master|doctor|ph\.?d/u.test(text))) return 0;
  const minimum = Math.min(...levels);
  if (config.education === null) state.review.add("education-unconfirmed");
  else if (EDUCATION.get(config.education) < minimum) state.reject.add("education-insufficient");
  return 1;
}

function hasUnconfirmedSpecialization(text) {
  const withoutGenericActivities = text.replace(/行业(?:活动|会议|会展|展会|沙龙|趋势|洞察|研究|分析)/gu, "");
  return /行业|领域|垂直市场|细分市场|industry|sector/u.test(withoutGenericActivities)
    || /医疗器械|医药|制药|医疗|半导体|芯片|汽车|工业制造|新能源|金融|证券|保险|房地产|medical|pharma|semiconductor|automotive/u.test(text);
}

function assessClause(clause, config, state, role, kind) {
  const { text, preferred, conflict, negated } = clause;
  const duty = kind === "duty";
  if (conflict) state.review.add("requirement-scope-ambiguous");
  if (preferred) {
    state.preferred = true;
    return;
  }
  if (negated) {
    if (!duty && /经验|学历|专业|experience|education/u.test(text)) state.explicit += 1;
    return;
  }
  if (text.length > 1000 || /[\p{Co}\ufffd]/u.test(text)) state.review.add("requirements-unreadable");
  const capabilities = capabilityRequirements(text, role, duty);
  for (const capability of capabilities) {
    if (!config.confirmedCapabilities.includes(capability)) state.review.add("capability-unconfirmed");
  }
  let assessed = capabilities.size;
  assessed += checkYears(text, config, state, role.years, kind === "experience");
  if (!duty) assessed += checkEducation(text, config, state, kind === "education");
  if (!duty && hasUnconfirmedSpecialization(text)) state.review.add("industry-specialization-unconfirmed");
  if (UNSUPPORTED_REQUIREMENT.test(text) || BUSINESS_SCALE.test(text)) state.review.add("requirement-unassessed");
  if (duty && UNRELATED_DUTY.test(text)) state.review.add("duties-unassessed");
  if (capabilities.has("budgetOwnership") && BUDGET_AMOUNT.test(text)) state.review.add("requirement-unassessed");
  if (!capabilities.has("isvEngineering") && /(?:自带|已有|拥有|具备|积累|^有|须有|需有).{0,16}(?:isv|伙伴|生态|媒体|渠道|客户).{0,8}资源/u.test(text)) state.review.add("requirement-unassessed");
  if (/毕业.{0,8}[0-9一二两三四五六七八九十]+年/u.test(text)) state.review.add("requirement-unassessed");
  if (/\b(?:python|java|verilog|vhdl|fpga|sql|c\+\+)\b/u.test(text) && capabilities.has("technicalDevelopment")) state.review.add("specialist-requirement-unassessed");
  if (!duty) {
    state.explicit += assessed;
    if (!assessed && !SOFT_SKILL.test(text) && !IGNORED.test(text)
      && !/^(?:不限|无要求|无硬性要求)$/u.test(text)) state.review.add("requirement-unassessed");
    if (/^(?:不限|无要求|无硬性要求)$/u.test(text) && ["experience", "education"].includes(kind)) state.explicit += 1;
  }
}

function readableSalary(value) {
  if (typeof value !== "string" || !safeMetadata(value, 80)) return null;
  const text = normalize(value);
  const unit = "(?:k|千|万(?:元)?|元)";
  const amount = "\\d+(?:,\\d{3})*(?:\\.\\d+)?";
  const salary = new RegExp(`^(?:${amount}(?:\\s*${unit}?\\s*[-–—~～至]\\s*${amount})?\\s*${unit}(?:\\s*\\/\\s*(?:月|年|天|日|小时))?(?:\\s*[·•x×* ]\\s*\\d+\\s*薪)?|(?:薪资|薪酬)?(?:面议|保密))$`, "u");
  return salary.test(text) ? value : null;
}

function publicJob(record, role, dutyText, state) {
  const concepts = [];
  if (/活动|会议|会展|\bevents?\b/u.test(dutyText)) concepts.push("涉及市场活动的组织与执行。");
  if (/内容|文案|材料|content/u.test(dutyText)) concepts.push("涉及面向业务的内容与沟通材料。");
  if (/线索|漏斗|mql|sales[- ]qualified leads?|pipeline/u.test(dutyText)) concepts.push("涉及线索跟进与业务漏斗协同。");
  if (/赋能|培训|enablement/u.test(dutyText)) concepts.push("涉及合作赋能与信息传递。");
  const requirements = [`需核实${role.concept}所涉及的实践要求。`, "岗位列有明确的任职条件，具体口径仍需按原始岗位复核。"];
  const concerns = ["规则初筛仅作排序参考，不代表资格已经得到确认。"];
  if (state.preferred) concerns.push("岗位另有优先条件，适用情况需进一步核实。");
  return {
    id: record.id, title: record.title ?? null, company: record.company ?? null,
    city: "上海", location: record.location ?? null, source: "BOSS直聘", url: record.url,
    salaryText: readableSalary(record.salaryText), salaryMinK: null, salaryMaxK: null, salaryMonths: null,
    experienceText: record.experienceText ?? null, educationText: record.educationText ?? null,
    category: role.category,
    // This ranks textual role signals, not the probability of qualification.
    matchScore: Math.min(85, 62 + Math.min(12, concepts.length * 3) + (BUSINESS.test(dutyText) ? 5 : 0) + 4),
    priority: "有条件匹配",
    summary: [`岗位职责侧重${role.concept}。`, ...concepts.slice(0, 2)],
    requirements,
    matchReasons: [`职责中识别到${role.concept}信号。`, "职责与任职要求已分区评估，建议进一步人工核实。"],
    concerns,
    languageNote: "工作语言以原始岗位为准，不据此排除国际团队",
    publishedAt: null, firstSeen: record.retrievedAt, lastSeen: record.retrievedAt,
    jdRead: true, isNew: true,
  };
}

function outcome(decision, reasons, job = null) {
  return { decision, reasons: [...new Set(reasons)].sort(), job };
}

export function screenJob(record, config) {
  validateMatchingConfig(config);
  const card = inspectCard(record);
  if (!card.eligible) return outcome(card.reason.startsWith("card-") ? "review" : "reject", [card.reason]);
  if (!fullTimestamp(record.retrievedAt)) return outcome("review", ["retrieval-time-invalid"]);
  if (typeof record.jd !== "string" || !record.jd.trim() || record.jd.length > 60000) return outcome("review", ["full-jd-missing-or-invalid"]);
  const places = [...normalize(record.jd).matchAll(/(?:工作地点|工作地址|工作地|办公地点|工作城市|办公城市|常驻地|常驻|驻地|\bbase(?:d)?(?: in)?)\s*[:：为在]?\s*([^\r\n。；;]+)/gu)]
    .map((match) => geography(match[1]));
  if (places.includes("other")) return outcome("reject", ["geography-outside-shanghai"]);
  if (geography(record.location) !== "shanghai" && !places.includes("shanghai")) return outcome("review", ["geography-unconfirmed"]);
  const parsed = parseJobSections(record);
  if (!parsed) return outcome("review", ["sections-invalid"]);
  if (!parsed.duties || !parsed.requirements) return outcome("review", ["requirements-unseparated"]);
  const duties = clauses(parsed.duties), requirements = clauses(parsed.requirements);
  if (duties.length > 200 || requirements.length > 200 || [...duties, ...requirements].some(({ text }) => text.length > 1000)) return outcome("review", ["sections-too-complex"]);
  if (requirements.some(({ text, preferred, negated }) => !preferred && !negated
    && /仅限在校|在校学生|在校生|仅限应届|只招应届|实习生|student.only|internship/u.test(text))) return outcome("reject", ["student-only"]);
  const signals = dutyRoles(duties);
  if (!signals.roles.length) {
    return outcome(duties.some(({ text, preferred, negated }) => !preferred && !negated && (engineering(text) || UNRELATED_DUTY.test(text))) ? "reject" : "review", ["duties-unsupported"]);
  }
  const allowed = signals.roles.filter(({ category }) => config.directions.includes(category));
  if (!allowed.length) return outcome("reject", ["direction-not-configured"]);
  const role = allowed.sort((a, b) =>
    Number(b.category === "伙伴营销") - Number(a.category === "伙伴营销")
    || Number(b.category === "产品市场") - Number(a.category === "产品市场")
    || ROLE_DEFINITIONS.indexOf(a) - ROLE_DEFINITIONS.indexOf(b))[0];
  const state = { review: new Set(), reject: new Set(), preferred: false, explicit: 0 };
  if (!config.confirmedCapabilities.includes(role.capability)) state.review.add("capability-unconfirmed");
  for (const clause of duties) assessClause(clause, config, state, role, "duty");
  for (const clause of requirements) assessClause(clause, config, state, role, "requirement");
  if (!state.explicit) state.review.add("requirements-insufficient");
  for (const [key, kind] of [["experienceText", "experience"], ["educationText", "education"]]) {
    if (record[key]) for (const clause of clauses(record[key])) assessClause(clause, config, state, role, kind);
  }
  if (state.reject.size) return outcome("reject", [...state.reject, ...state.review]);
  if (state.review.size) return outcome("review", state.review);
  return outcome("select", ["duties-supported", "requirements-assessed"], publicJob(record, role, signals.text, state));
}
