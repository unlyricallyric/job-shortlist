const compact = (value) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const negate = (value) => value.replace(/(?<=[\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, "")
  .replace(/(?:并非|不是|不属于|不采用|非|无)(?:人力|劳务|第三方)?(?:外包|派遣)(?:制|用工|岗位|岗)?/gu, "正式安排")
  .replace(/(?:non[- ]?|not\s+(?:an?\s+)?|no\s+)(?:outsourced|outsourcing|agency[- ]employed|staffing agency employment)/giu, "direct employment");
const roleContextEnd = /晋升(?:通道|路径)|职业发展|汇报对象|career\s+path|report(?:s|ing)?\s+to/iu;
const otherParty = /(?:管理|对接|协调|采购|销售|提供|负责).{0,8}(?:外包团队|外包供应商|外包服务|派遣服务)|(?:客户|供应商)(?:的)?外包伙伴|(?:manage|coordinate|sell|provide).{0,14}(?:outsourcingservices|outsourcedteams|staffingservices)/u;

function titleOutsourcing(title) {
  const normalized = negate((title ?? "").normalize("NFKC").split(roleContextEnd)[0]);
  const tagged = /[（(【\[]\s*(?:(?:(?:人力|劳务|第三方|项目)\s*)?(?:外\s*包|劳\s*务\s*派\s*遣)(?:\s*(?:岗|岗位|用工|制))?|outsourced|agency[- ]?employed|labou?r[- ]?dispatch)\s*[）)】\]]/iu.test(normalized);
  const text = compact(normalized)
    .replace(/(?:外包团队|外包供应商|外包项目)(?:管理|协调)|(?:销售|管理|采购|提供|对接)外包(?:团队|服务|伙伴|供应商)|外包服务(?:销售|商务|合作)|客户(?:的)?外包伙伴/gu, "业务对象");
  if (tagged) return true;
  return !otherParty.test(text) && (
    /^(?:(?:人力|第三方|劳务)?外包(?!公司|团队|服务|供应商|项目管理)|劳务派遣|派遣制).{0,24}(?:岗位|专员|工程师|经理|运营|开发|支持)|(?:岗位|职位|用工|合同)(?:为|属|属于|采用)?(?:人力外包|外包|劳务派遣)(?!公司|团队|服务|供应商|管理|业务)|(?:外包|劳务派遣)(?:岗位|岗|用工|职位|制)$|^outsourced(?:role|position|staff|employee|specialist|engineer|manager|partner)|^agencyemployed/u.test(text)
  );
}

function employedArrangement(fragment) {
  const text = compact(negate(fragment));
  if (/不与|不由|无需与|不会与|notemployedby|notcontractedthrough/u.test(text)) return false;
  if (otherParty.test(text) && !/(?:本岗位|该岗位|本职位|该职位|用工形式|雇佣形式)(?:为|是|系|属于|采用)/u.test(text)) return false;
  const explicit = /(?:本岗位|该岗位|本职位|该职位|本次招聘岗位|此岗位|此职位)(?:为|是|系|属于|采用|以)(?:人力|第三方|劳务)?(?:外包|派遣)(?!公司|企业|团队|服务|供应商|管理|业务)|(?:用工形式|用工性质|雇佣形式|岗位性质|职位性质)(?:为|是|采用)?(?:外包|人力外包|劳务派遣)(?!公司|企业|团队|服务|供应商|管理|业务)|(?:this|the)(?:role|position|job)(?:is|willbe|uses?)(?:an?)?(?:outsourced|agencyemployed|staffingagencyemployment)/u;
  if (explicit.test(text)) return true;
  const self = /^(?:备注|说明|注意|用工说明|雇佣安排|合同说明)?(?:入职后|录用后|受聘者|应聘者|你将|您将|本岗位|该岗位|本职位|劳动合同|签约主体|与(?:外包|派遣|劳务|人力资源|第三方)|(?:this|the)(?:role|position|job))|(?:youwillbe|successfulcandidatewillbe|employmentwillbe|employmentis|contractwillbe)/u.test(text);
  const laborContract = /(?:与|由).{0,18}(?:外包公司|外包服务商|派遣公司|劳务公司|人力资源公司|第三方(?:公司|服务公司|人力公司|外包公司)?).{0,14}(?:签订|签署|签约).{0,8}(?:劳动合同|雇佣合同)|劳动合同.{0,12}(?:外包|派遣|劳务|第三方)|(?:employedby|employmentcontractwith|contractedthrough)(?:an?)?(?:thirdparty|staffingagency|outsourcingcompany)/u.test(text);
  const assigned = /(?:派驻|派遣|安排|外派).{0,15}(?:客户|用工单位|客户方|客户单位).{0,8}(?:工作|办公|现场|项目)?|(?:assignedto|workingat|placedat)(?:the)?(?:client|customer)/u.test(text);
  const payroll = /(?:由|通过).{0,10}(?:第三方|派遣公司|外包公司).{0,10}(?:发薪|发放工资|雇佣)|(?:payroll|employment)through(?:an?)?(?:staffingagency|thirdparty)/u.test(text);
  return self && assigned && (laborContract || payroll);
}

export function assessOutsourcedEmployment(record) {
  if (titleOutsourcing(record.title)) return { category: "outsourced-employment", reasonCode: "role-outsourced-employment", basis: "title" };
  if (typeof record.jd !== "string" || record.jd.length < 80 || record.jd.length > 60000) return null;
  const lines = record.jd.normalize("NFKC").split(/[\r\n。；;]+/u).map((line) => line.replace(/^\s*(?:[-*•]|\d+[、.)])\s*/u, "").trim()).filter(Boolean);
  for (const line of lines) {
    if (/任职要求|任职资格|岗位职责|工作职责|公司介绍/u.test(line)) {
      const statement = line.replace(/^(?:任职要求|任职资格|岗位职责|工作职责|公司介绍)\s*[:：]?\s*/u, "");
      if (employedArrangement(statement)) return { category: "outsourced-employment", reasonCode: "role-outsourced-employment", basis: "employment" };
    } else if (employedArrangement(line)) {
      return { category: "outsourced-employment", reasonCode: "role-outsourced-employment", basis: "employment" };
    }
  }
  return null;
}
