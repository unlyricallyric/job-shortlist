import { occupationalSections } from "./technical-roles.mjs";

const compact = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "");
const futureOrReporting = /晋升(?:通道|方向|路径)?|职业发展|汇报(?:对象|关系)|report(?:s|ing)?\s+to|career\s+path/iu;
const businessRole = /伙伴|生态合作|合作伙伴|渠道销售|商业合作|商务拓展|partnerdevelopment|channelmanager|businessdevelopment/u;

export function assessOtherOccupation(record) {
  const title = compact((record.title ?? "").split(futureOrReporting)[0]);
  const result = (category, basis) => ({ category, reasonCode: `role-${category}`, basis });
  const titleRules = [
    ["human-resources", /^(?:高级|资深)?hrbp$|hrbusinesspartner|humanresources(?:manager|partner|specialist)|(?:招聘|人力资源|薪酬绩效|员工关系)(?:专员|经理|主管|总监)|招聘运营/u.test(title)],
    ["production-planning", /生产计划(?:员|经理|专员|主管)|生产调度|productionplanner|productionplanningmanager/u.test(title)],
    ["finance-settlement", /^(?:高级|资深)?(?:财务|会计|出纳)(?:经理|总监|主管|专员|助理|专家|负责人|核算|结算|$)|清结算|清算运营|(?:支付|资金|账务|财务|渠道)?结算(?:专员|经理|运营)|^结算|accountant|bookkeeper|settlement(?:specialist|manager)/u.test(title)],
    ["consumer-operations", /(?:游戏|手游|商家|酒旅|文旅|酒店|专科|口腔|消费医疗|公充)(?:业务|渠道|用户|内容)?运营|游戏发行|game(?:operations|useracquisition)|merchantoperations/u.test(title)],
    ["professional-marketing", /信息流优化|广告(?:投放|优化|投手)|投放优化|品牌(?:活动)?策展|(?:内容|品牌|公关)(?:营销|传播|策划)(?:专家|专员|经理)|品牌活动(?:合作|策划)专家|科技内容传播|新媒体运营|paidmedia(?:manager|specialist)|performancemarketing|publicrelations(?:specialist|manager)/u.test(title)],
    ["product-delivery", /产品经理|productmanager/u.test(title)
      || (!businessRole.test(title) && /(?:技术|软件|实施|外包)?交付经理|implementationmanager|deliverymanager/u.test(title))],
    ["internal-operations", /(?:内部|部门)(?:行政|运营|事务)管理|行政(?:专员|经理|运营)|办公室事务|officeadministrator/u.test(title)],
  ];
  for (const [category, matches] of titleRules) if (matches) return result(category, "title");
  const { duties } = occupationalSections(record);
  const clauses = duties.split(futureOrReporting)[0].split(/[\r\n。；;]+/u).map(compact)
    .filter((text) => /负责|主导|牵头|开展|执行|处理|制定|维护|核对|manage|lead|own|responsiblefor/u.test(text)
      && !/不负责|不涉及|不承担|notresponsible/u.test(text));
  const business = clauses.filter((text) => /(?:招募|拓展|经营|签约).{0,12}(?:伙伴|代理商|经销商)|伙伴准入|伙伴赋能|联合销售|商机互荐|partnerrecruitment/u.test(text));
  const functions = [
    ["human-resources", /招聘渠道|候选人(?:筛选|面试|寻访)|人才(?:招聘|引进)|人力资源规划|员工关系|薪酬核算|招聘需求/u],
    ["production-planning", /生产(?:排程|计划)|物料(?:排期|计划)|制造排程|排产/u],
    ["finance-settlement", /账务处理|资金结算|清结算|清算|收支核算|财务报表|对账差异|发票核销|核对.{0,8}(?:账单|账务)|开票.{0,8}对账/u],
    ["consumer-operations", /游戏(?:玩家|用户|买量|留存)|玩家活跃|商家(?:经营|日常运营|活动运营)|酒店(?:订单|房源|日常运营)|消费医疗(?:门店|诊所)运营/u],
    ["professional-marketing", /广告投放|投放渠道|媒体采买|买量策略|信息流优化|品牌策展|公关稿件|pr传播/u],
    ["product-delivery", /产品路线图|产品功能设计|撰写prd|需求原型|产品需求文档|独立.{0,8}项目交付|项目交付验收/u],
    ["internal-operations", /部门日常行政|办公(?:用品|资产|资源)管理|考勤管理|内部事务|行政费用/u],
  ];
  for (const [category, pattern] of functions) {
    const matched = clauses.filter((text) => pattern.test(text));
    if (matched.length >= 2 && matched.length > business.length) return result(category, "duties");
  }
  return null;
}
