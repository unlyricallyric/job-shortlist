import { parseJobSections } from "./screening.mjs";

const compact = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "");
const careerContext = /晋升(?:通道|方向|路径)?|职业发展|发展通道|汇报(?:对象|关系)|report(?:s|ing)?\s+to|career\s+path|promotion\s+to/iu;
const technicalStack = /java|python|golang|rust|c\+\+|c#|javascript|typescript|react|vue|android|ios|kotlin|swift|cuda|gpu|hpc|linux|kubernetes|k8s|docker|容器|算子|内核|云平台|大模型|算法|框架|软硬件/u;
const technicalRole = /软件(?:开发|研发|测试)?工程师|(?:前端|后端|全栈|移动端|嵌入式|算法|机器学习|深度学习|模型|数据|云计算|网络|安全|运维|系统|性能|测试)(?:开发|研发|架构|安全)?工程师|数据科学家|系统管理员|数据库管理员|(?:软件|云|系统|网络|安全|ai|数据)?架构师|(?:软件|技术|研发|后端|前端)(?:研发|开发)?(?:管理)?(?:经理|总监|负责人)|software(?:engineer|developer|architect)|(?:frontend|backend|fullstack|mobile|embedded|security|network|systems?|cloud|performance|test|data|ml|ai|machinelearning)(?:software)?engineer|datascientist|(?:systems?|network|database)administrator|solutions?architect|cloudarchitect|systems?architect|securityarchitect|technicalarchitect|aiarchitect|engineeringmanager|rdmanager|headofengineering|devopsengineer|sitereliabilityengineer/u;
const standaloneTechnical = /^(?:senior|staff|principal|高级|资深)?(?:sre|devops|dba)(?:工程师|engineer)?$/u;
const technicalOperationsTitle = /(?:sre|devops|dba)(?:工程师|engineer|专家)|^(?:高级|资深)?it(?:高级|资深)?经理|^itmanager|机房(?:经理|运维|管理员)|datacenteroperationsmanager|(?:mes|erp|sap|软件)(?:实施|交付|项目)(?:经理|顾问|工程师)|无人车(?:运营|运维|软件|算法|测试)工程师|autonomousvehicle(?:operations)?engineer|解决方案工程师|solutions?engineer/u;
const delegate = /(?:协调|对接|沟通|联络|联合).{0,14}(?:研发|开发|工程师|技术团队|架构师|供应商)|(?:coordinate|liaise|workwith|partnerwith).{0,20}(?:engineer|developer|technicalteam)/u;
const contextClause = /晋升|汇报|面向.{0,15}(?:工程师|架构师)|客户.{0,8}(?:cto|技术负责人)|产品(?:功能|介绍|特性)|(?:our|the)product(?:supports|provides)|careerpath|reportsto/u;
const negation = /无需|不要求|不负责|不涉及|不承担|无须|不需要|不必|不编写|不做(?:编码|开发)|notrequired|nocoding|doesnotrequire|notresponsiblefor/u;
const technicalWork = /(?:编写|编程|编码|实现|开发|维护|调试|优化|排查|设计).{0,14}(?:代码|sdk|算法|算子|内核|驱动程序|设备驱动|固件|api接口|软件接口|后端服务|前端组件|系统架构|软件架构|分布式系统|数据管道|数据模型|数据库)|(?:代码|sdk|算法|算子|内核|驱动程序|设备驱动|固件|后端|前端|系统架构|软件架构|数据管道).{0,10}(?:开发|编码|调试|设计|优化)|(?:独立|主导|负责).{0,12}(?:部署|配置|排障|调优).{0,14}(?:系统|集群|kubernetes|k8s|linux|网络|数据库|服务器|容器)|(?:训练|微调|推理优化).{0,12}(?:模型|算法)|(?:模型|算法).{0,8}(?:训练|微调|推理优化)|(?:write|implement|develop|debug|maintain|optimize|design).{0,18}(?:code|sdk|kernel|compiler|algorithm|firmware|backend|frontend|apis|datapipeline|distributed(?:systems?)?)|(?:deploy|configure|troubleshoot|debug|tune).{0,18}(?:kubernetes|k8s|linux|clusters?|infrastructure|containers?|servers?)|(?:train|finetune).{0,12}models?/u;
const language = /(?:java(?:script)?|python|typescript|golang|rust|cuda|c\+\+|c#|kotlin|swift)\b/iu;
const handsOnRequired = /(?:必须|需要|要求|须|具备|掌握|熟练|精通|具有|至少).{0,25}(?:编程|编码|软件开发|系统设计|架构设计|底层配置|系统排障|系统部署|研发经验|研发背景)|(?:proficien|expert|experience|ability|required|must|hands-on).{0,35}(?:coding|programming|softwaredevelopment|systemdesign|debugging|deployment|configuration)/u;

function positionTitle(value) {
  const title = (value ?? "").normalize("NFKC").split(careerContext)[0]
    .replace(/(?:面向|对接|支持|协同)(?:客户)?(?:软件工程师|开发者|架构师|CTO|研发团队)[^，,；;）)]*/giu, "")
    .replace(/(?:for|supporting)\s+(?:software\s+engineers|developers|architects)\b/giu, "");
  return compact(title).replace(/(?:合作伙伴|伙伴|商业|商务|业务|市场|客户|渠道)开发/gu, "商业拓展");
}

export function occupationalSections(record) {
  if (typeof record.jd !== "string" || record.jd.length < 80 || record.jd.length > 60000) return { duties: "", requirements: "" };
  const text = record.jd.normalize("NFKC").replace(/(?<=[\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, "");
  const parsed = parseJobSections({ jd: text });
  const duties = /(?:^|\n)\s*(?:job\s+|key\s+)?(?:responsibilities|duties|what you(?:'ll| will) do)\s*:?\s*\n?([\s\S]*?)(?=\n\s*(?:(?:required|preferred|minimum)\s+)?(?:qualifications|requirements|benefits|career path|about us)\b|$)/iu.exec(text)?.[1];
  const requirements = /(?:^|\n)\s*(?:(?:required|minimum)\s+)?(?:qualifications|requirements|what you bring)\s*:?\s*\n?([\s\S]*?)(?=\n\s*(?:preferred|nice to have|benefits|career path|about us)\b|$)/iu.exec(text)?.[1];
  return { duties: parsed?.duties || duties || "", requirements: parsed?.requirements || requirements || "" };
}

function clauses(text) {
  return text.split(careerContext)[0].split(/[\r\n。；;]+/u).map((clause) =>
    clause.replace(/^\s*(?:\d+[、.)]|[-*•])\s*/u, "").trim()).filter(Boolean);
}

function personalTechnicalWork(clause) {
  return clause.split(/[，,](?=\s*(?:(?:并且|并|同时|且|但|而)\s*)?(?:本岗位|该岗位)?(?:不负责|不承担|无需|无须|不要求|不涉及|不需要|协调|协同|对接|负责|主导|独立|必须|需要|personally|independently|coordinate|not\s+responsible))/iu)
    .some(technicalFragment);
}

function technicalFragment(clause) {
  const text = compact(clause).replace(/(?:更新|维护|管理|整理|建立).{0,6}(?:伙伴|客户|商机|联系人|销售|业务)数据库/gu, "维护业务档案");
  if (contextClause.test(text) || delegate.test(text) || negation.test(text)
    || /(?:技术文档|技术demo|demo|sdk|示例代码|技术内容|接入教程|技术课程|课程|软件代码).{0,16}由.{0,12}(?:研发|技术|专业).{0,10}(?:提供|编写|负责|开发|完成)/u.test(text)) return false;
  const buildsTechnicalContent = /(?:负责|主导|独立).{0,24}(?:建设|搭建|产出|撰写|维护)/u.test(text)
    && ["技术文档", "接入教程", "技术文章", "开发者文档", "sdk文档", "示例代码"].filter((item) => text.includes(item)).length >= 2;
  return technicalWork.test(text)
    || buildsTechnicalContent
    || /独立.{0,14}(?:接入教程|技术文章|demo)|(?:编写|开发|调试).{0,14}(?:代码示例|可运行demo|sdk文档)/u.test(text)
    || /(?:建设|搭建|编写|撰写|产出|维护).{0,14}(?:技术文档|接入教程|开发者文档|技术文章|sdk文档)/u.test(text)
    || /(?:独立|主导).{0,12}设计.{0,14}(?:解决方案架构|技术架构|部署架构|云架构)/u.test(text)
    || /(?:独立|主导).{0,20}(?:方案|系统)设计.{0,18}(?:架构图|技术建议书)/u.test(text)
    || (language.test(clause) && /编程|编码|(?:编写|调试).{0,12}(?:脚本|程序)|(?:java|python|javascript|typescript|golang|rust|cuda|kotlin|swift).{0,8}(?:代码|开发经验)|(?:write|debug|implement).{0,20}(?:scripts?|programs?|code)/u.test(text));
}

export function assessTechnicalFunction(record) {
  const title = positionTitle(record.title);
  if (technicalRole.test(title) || standaloneTechnical.test(title) || technicalOperationsTitle.test(title)
    || ((technicalStack.test(title) || technicalStack.test((record.title ?? "").normalize("NFKC").toLowerCase()))
      && /(?:研发|开发|技术)(?:管理)?(?:经理|专家|工程师|支持|负责人|总监)|工程师|(?:developer|engineer)(?:$|[（(])/u.test(title))) {
    return { category: "technical-function", reasonCode: "role-technical-function", basis: "title" };
  }
  const sections = occupationalSections(record);
  if (clauses(sections.duties).some(personalTechnicalWork)) {
    return { category: "technical-function", reasonCode: "role-technical-function", basis: "duties" };
  }
  let preferred = false;
  for (const clause of clauses(sections.requirements).flatMap((text) => text.split(/[，,]/u))) {
    const text = compact(clause);
    if (/^(?:加分项|加分技能|优先条件|优先要求|preferred|nicetohave)/u.test(text)) preferred = true;
    else if (/^(?:必备条件|基本要求|必要条件|硬性要求|required|minimum)/u.test(text)) preferred = false;
    if (preferred || /优先|加分|非必需|非必备|preferred|bonus|nicetohave/u.test(text)
      || negation.test(text) || contextClause.test(text) || delegate.test(text)) continue;
    if (handsOnRequired.test(text) || personalTechnicalWork(clause)
      || (language.test(clause) && /精通|熟练掌握|编程|编码|开发经验|proficien|programming|coding|hands-on/iu.test(clause)
        && !/(?:java|python|javascript|typescript|golang|rust|cuda|kotlin|swift)(?:生态|产品|社区|合作|商业)/u.test(text))) {
      return { category: "technical-function", reasonCode: "role-technical-function", basis: "requirements" };
    }
  }
  return null;
}
