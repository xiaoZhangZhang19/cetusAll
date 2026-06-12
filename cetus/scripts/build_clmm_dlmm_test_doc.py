from __future__ import annotations

import datetime as dt
import html
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path("/Users/xiaojian/Documents/item/QA")
SOURCE_XLSX = ROOT / "Cetus-基础交易.xlsx"
OUTPUT_DIR = ROOT / "outputs" / "clmm-dlmm-test-doc"
OUTPUT_XLSX = OUTPUT_DIR / "CLMM-DLMM-自动化测试文档.xlsx"

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def parse_source_workbook(path: Path) -> dict[str, list[list[str]]]:
    ns = {"a": MAIN_NS}
    with zipfile.ZipFile(path) as zf:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            shared_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for item in shared_root.findall("a:si", ns):
                texts = [node.text or "" for node in item.findall(".//a:t", ns)]
                shared_strings.append("".join(texts))

        workbook_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        relation_map = {
            rel.attrib["Id"]: f"xl/{rel.attrib['Target']}"
            for rel in rels_root
            if rel.attrib.get("Target", "").startswith("worksheets/")
        }

        sheet_data: dict[str, list[list[str]]] = {}
        sheets = workbook_root.find(f"{{{MAIN_NS}}}sheets")
        if sheets is None:
            return sheet_data

        for sheet in sheets:
            name = sheet.attrib["name"]
            relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
            sheet_path = relation_map[relationship_id]
            sheet_root = ET.fromstring(zf.read(sheet_path))
            rows: list[list[str]] = []
            for row in sheet_root.findall(f".//{{{MAIN_NS}}}sheetData/{{{MAIN_NS}}}row"):
                values: list[str] = []
                for cell in row.findall(f"{{{MAIN_NS}}}c"):
                    cell_type = cell.attrib.get("t")
                    value_node = cell.find(f"{{{MAIN_NS}}}v")
                    if cell_type == "inlineStr":
                        inline_text = "".join(
                            node.text or ""
                            for node in cell.findall(f".//{{{MAIN_NS}}}t")
                        )
                        values.append(inline_text)
                    elif value_node is not None:
                        raw_value = value_node.text or ""
                        if cell_type == "s":
                            values.append(shared_strings[int(raw_value)])
                        else:
                            values.append(raw_value)
                    else:
                        values.append("")
                rows.append(values)
            sheet_data[name] = rows
        return sheet_data


def classify_module(feature: str, point: str) -> str:
    point_lower = point.lower()
    if "swap" in point_lower and "merge" in point_lower:
        return "交易/聚合兑换"
    if "swap" in point_lower:
        return "交易/兑换"
    if "create pool" in point_lower or "create-pool" in point_lower:
        return "池管理"
    if "limit" in point_lower:
        return "限价单"
    if point_lower == "dca":
        return "DCA"
    if "vault" in point_lower and "farm" in point_lower:
        return "Vaults/Farming"
    if "vault" in point_lower and "稳" in point:
        return "Vaults/稳定池"
    if "vault" in point_lower or "vaults" in point_lower:
        return "Vaults/非稳定池"
    if "farm" in point_lower:
        return "Farms"
    if "xcetus" in point_lower:
        return "xCETUS"
    if "margin" in point_lower:
        return "Margin"
    if "lp_burn" in point_lower:
        return "仓位管理"
    if "rebalance" in point_lower or "compound" in point_lower or "merged" in point_lower:
        return "仓位策略"
    if "zap" in point_lower:
        return "Zap 单边流动性"
    if "claim" in point_lower:
        return "收益/费用"
    if "increase" in point_lower:
        return "流动性管理"
    if "remov" in point_lower or "remove" in point_lower:
        return "流动性管理"
    if "add" in point_lower:
        return "流动性管理"
    if "compensation" in point_lower:
        return "补偿"
    return f"{feature} 核心流程"


def normalize_point(point: str) -> str:
    normalized = point.strip()
    normalized = normalized.replace("remov", "remove")
    normalized = normalized.replace("merage", "merge")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def should_include(feature: str, point: str) -> tuple[str, str]:
    point_lower = point.lower()
    included_points = {
        ("CLMM", "add添加流动性"),
        ("CLMM", "remov移除流动性"),
        ("DLMM", "Dlmm-add添加流动性"),
        ("DLMM", "Dlmm-remov移除流动性"),
    }
    if (feature, point) in included_points:
        return "是", "当前仓位创建/移除链路已有自动化基础，纳入首期实现"

    if "swap" in point_lower or "create pool" in point_lower or "create-pool" in point_lower:
        return "否", "核心价值较高，但当前阶段优先完成流动性主链路，后续补充"

    if "claim" in point_lower or "farm" in point_lower or "xcetus" in point_lower:
        return "否", "依赖奖励、质押或运营态数据，首期暂不纳入"

    if "vault" in point_lower or "margin" in point_lower:
        return "否", "跨业务域或依赖复杂前置状态，首期暂不纳入"

    if "zap" in point_lower or "rebalance" in point_lower or "compound" in point_lower or "merged" in point_lower:
        return "否", "路径复杂且依赖仓位状态，建议在核心链路稳定后补充"

    if "limit" in point_lower or point_lower == "dca":
        return "否", "该能力已有独立自动化方向，不纳入本次 CLMM/DLMM 范围"

    return "否", "非首期自动化范围，建议后续按优先级补充"


def priority_for(point: str, included: str) -> str:
    point_lower = point.lower()
    if included == "是":
        return "P0"
    if "swap" in point_lower or "create pool" in point_lower or "create-pool" in point_lower:
        return "P1"
    if "increase" in point_lower or "claim" in point_lower or "lp_burn" in point_lower:
        return "P1"
    if "zap" in point_lower or "rebalance" in point_lower or "compound" in point_lower or "merged" in point_lower:
        return "P2"
    if "vault" in point_lower or "farm" in point_lower or "xcetus" in point_lower or "margin" in point_lower:
        return "P2"
    return "P2"


def validation_points(module: str, expected_result: str, included: str, point: str) -> str:
    point_lower = point.lower()
    generic_success = "钱包确认成功；页面出现成功提示；链路执行完成"

    if "swap" in point_lower:
        return "路由/交易对正确；输入输出币种余额变化正确；交易成功；Explorer 链接可用"
    if "create pool" in point_lower or "create-pool" in point_lower:
        return "交易成功；新池子创建成功；交易对与 fee rate 展示正确；池子信息同步正确"
    if "add" in point_lower and "zap" not in point_lower:
        return "交易成功；输入数量可提交；新增仓位或仓位流动性增加；页面/仓位数据与提交数量一致"
    if "remov" in point_lower or ("remove" in point_lower and "zap" not in point_lower):
        return "交易成功；仓位流动性减少或清空；返还 token 数量合理；成功提示与仓位变化一致"
    if "increase" in point_lower:
        return "交易成功；原仓位流动性增加；增加前后仓位数量变化正确"
    if "claim" in point_lower:
        return "交易成功；fee/reward 领取成功；领取数量与页面展示一致"
    if "zap" in point_lower:
        return "单边注入/移除成功；目标 token 扣减或返还正确；仓位变化符合预期"
    if "rebalance" in point_lower or "compound" in point_lower or "merged" in point_lower:
        return "claim/merge/compound/rebalance 各动作成功；仓位状态更新正确；结果与页面展示一致"
    if "farm" in point_lower:
        return "stake/unstake/claim 结果正确；仓位状态与奖励数量变化正确"
    if "vault" in point_lower:
        return "双边/单边路径可执行；增加或减少数量与页面展示一致；交易成功"
    if "xcetus" in point_lower:
        return "质押/赎回/claim 成功；数量与 Vesting 或奖励展示一致"
    if "limit" in point_lower:
        return "下单成功；满足价格条件后可成交；成交后余额变化正确"
    if point_lower == "dca":
        return "下单成功；达到成交条件后可成交；订单状态与余额变化正确"
    if "margin" in point_lower:
        return "开仓/关仓成功；仓位状态与资产变化正确"
    if "lp_burn" in point_lower:
        return "锁仓成功；锁仓后仅允许 claim fee/reward，不允许追加或移除"
    if "compensation" in point_lower:
        return "补偿领取成功；领取数量正确"
    if included == "是":
        return generic_success
    return expected_result.replace("\n", "；")


def enrich_rows(feature: str, raw_rows: list[list[str]]) -> list[list[str]]:
    enriched: list[list[str]] = []
    for raw in raw_rows[1:]:
        if len(raw) < 3:
            continue
        point = raw[0].strip()
        scenario = raw[1].strip()
        expected_result = raw[2].strip()
        included, note = should_include(feature, point)
        module = classify_module(feature, point)
        enriched.append(
            [
                feature,
                module,
                normalize_point(point),
                scenario,
                included,
                validation_points(module, expected_result, included, point),
                priority_for(point, included),
                "待分配",
                note,
            ]
        )
    return enriched


def col_letter(index: int) -> str:
    result = []
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        result.append(chr(65 + remainder))
    return "".join(reversed(result))


def xml_escape(text: str) -> str:
    return html.escape(text, quote=False)


def cell_xml(ref: str, value: str, style_id: int) -> str:
    text = xml_escape(value)
    return (
        f'<c r="{ref}" t="inlineStr" s="{style_id}">'
        f'<is><t xml:space="preserve">{text}</t></is></c>'
    )


def sheet_xml(
    rows: list[list[str]],
    widths: list[int],
    sheet_name: str,
    autofilter_range: str,
) -> str:
    row_chunks: list[str] = []
    for row_index, row in enumerate(rows, start=1):
        cells: list[str] = []
        for col_index, value in enumerate(row, start=1):
            ref = f"{col_letter(col_index)}{row_index}"
            style_id = 1 if row_index == 1 else 2
            cells.append(cell_xml(ref, str(value), style_id))
        custom_height = ' ht="26" customHeight="1"' if row_index == 1 else ""
        row_chunks.append(f'<row r="{row_index}"{custom_height}>{"".join(cells)}</row>')

    cols_xml = "".join(
        f'<col min="{idx}" max="{idx}" width="{width}" customWidth="1"/>'
        for idx, width in enumerate(widths, start=1)
    )
    last_col = col_letter(len(widths))
    last_row = max(len(rows), 1)
    dimension = f"A1:{last_col}{last_row}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{MAIN_NS}" xmlns:r="{REL_NS}">'
        f"<dimension ref=\"{dimension}\"/>"
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
        "</sheetView></sheetViews>"
        '<sheetFormatPr defaultRowHeight="20"/>'
        f"<cols>{cols_xml}</cols>"
        f"<sheetData>{''.join(row_chunks)}</sheetData>"
        f'<autoFilter ref="{autofilter_range}"/>'
        "<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>"
        "</worksheet>"
    )


def workbook_xml(sheet_names: list[str]) -> str:
    sheets_xml = "".join(
        f'<sheet name="{xml_escape(name)}" sheetId="{idx}" r:id="rId{idx}"/>'
        for idx, name in enumerate(sheet_names, start=1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{MAIN_NS}" xmlns:r="{REL_NS}">'
        '<workbookPr defaultThemeVersion="166925"/>'
        "<bookViews><workbookView xWindow=\"240\" yWindow=\"15\" windowWidth=\"16095\" windowHeight=\"9660\"/></bookViews>"
        f"<sheets>{sheets_xml}</sheets>"
        '<calcPr calcId="191029"/>'
        "</workbook>"
    )


def workbook_rels_xml(sheet_count: int) -> str:
    rels = []
    for idx in range(1, sheet_count + 1):
        rels.append(
            f'<Relationship Id="rId{idx}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{idx}.xml"/>'
        )
    rels.append(
        f'<Relationship Id="rId{sheet_count + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{''.join(rels)}"
        "</Relationships>"
    )


def content_types_xml(sheet_count: int) -> str:
    overrides = [
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for idx in range(1, sheet_count + 1):
        overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{idx}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f"{''.join(overrides)}"
        "</Types>"
    )


def root_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
        'Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
        'Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def app_xml(sheet_names: list[str]) -> str:
    titles = "".join(f"<vt:lpstr>{xml_escape(name)}</vt:lpstr>" for name in sheet_names)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>Cursor</Application>"
        f"<TitlesOfParts><vt:vector size=\"{len(sheet_names)}\" baseType=\"lpstr\">{titles}</vt:vector></TitlesOfParts>"
        f"<HeadingPairs><vt:vector size=\"2\" baseType=\"variant\"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>{len(sheet_names)}</vt:i4></vt:variant></vt:vector></HeadingPairs>"
        "</Properties>"
    )


def core_xml() -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:creator>Cursor</dc:creator>"
        "<cp:lastModifiedBy>Cursor</cp:lastModifiedBy>"
        "<dc:title>CLMM DLMM 自动化测试文档</dc:title>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{MAIN_NS}">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
        "</fonts>"
        '<fills count="3">'
        '<fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>'
        "</fills>"
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
        "</cellXfs>"
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def build_summary_rows(clmm_rows: list[list[str]], dlmm_rows: list[list[str]]) -> list[list[str]]:
    total_rows = clmm_rows + dlmm_rows
    included_total = sum(1 for row in total_rows if row[4] == "是")
    excluded_total = len(total_rows) - included_total

    return [
        ["维度", "内容"],
        ["文档范围", "基于 Cetus-基础交易.xlsx 中的 Clmm / Dlmm 测试点进行整理"],
        ["CLMM 测试点数量", str(len(clmm_rows))],
        ["DLMM 测试点数量", str(len(dlmm_rows))],
        ["纳入首期自动化数量", str(included_total)],
        ["暂不纳入数量", str(excluded_total)],
        ["纳入标准", "优先覆盖核心资金主链路，且当前项目已有自动化基础的场景"],
        ["负责人默认值", "待分配"],
        ["优先级说明", "P0=首期必做；P1=核心补充；P2=后续增强"],
    ]


def write_workbook(output_path: Path, sheets: list[tuple[str, list[list[str]], list[int]]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet_names = [sheet_name for sheet_name, _, _ in sheets]
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml(len(sheets)))
        zf.writestr("_rels/.rels", root_rels_xml())
        zf.writestr("docProps/app.xml", app_xml(sheet_names))
        zf.writestr("docProps/core.xml", core_xml())
        zf.writestr("xl/workbook.xml", workbook_xml(sheet_names))
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml(len(sheets)))
        zf.writestr("xl/styles.xml", styles_xml())

        for idx, (_, rows, widths) in enumerate(sheets, start=1):
            last_col = col_letter(len(widths))
            autofilter_range = f"A1:{last_col}{len(rows)}"
            zf.writestr(
                f"xl/worksheets/sheet{idx}.xml",
                sheet_xml(rows, widths, f"sheet{idx}", autofilter_range),
            )


def main() -> None:
    source = parse_source_workbook(SOURCE_XLSX)
    clmm_rows = enrich_rows("CLMM", source["Clmm"])
    dlmm_rows = enrich_rows("DLMM", source["Dlmm"])

    header = ["功能", "模块", "测试点", "测试场景", "是否纳入测试", "需要校验的点", "优先级", "负责人", "备注"]
    summary_rows = build_summary_rows(clmm_rows, dlmm_rows)

    sheets = [
        ("汇总", summary_rows, [18, 70]),
        ("CLMM", [header, *clmm_rows], [12, 18, 28, 42, 14, 48, 10, 12, 36]),
        ("DLMM", [header, *dlmm_rows], [12, 18, 28, 42, 14, 48, 10, 12, 36]),
    ]

    write_workbook(OUTPUT_XLSX, sheets)
    print(OUTPUT_XLSX)


if __name__ == "__main__":
    main()
