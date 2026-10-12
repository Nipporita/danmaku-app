# -*- coding: utf-8 -*-
"""把「主观题出题」docx 转成前端题库 fourth_righter_questions.js。

docx 里的行格式是：

    题目正文（出题人）后面跟着的吐槽/补充

处理规则（按出题人要求）：
1. 出题人写在**最后一对**括号里，取出来单独放 `by` 字段（大屏会显示"出题人：xxx"）；
   题目正文 = 这一对括号**之前**的内容 —— 所以 `最有冲击力的动漫名场面（/台词）（沙）`
   这种嵌套也能正确取到正文 `最有冲击力的动漫名场面（/台词）` 和出题人 `沙`。
2. 括号**后面**的东西一律丢掉（那些是吐槽，比如"战斗，爽 战斗，爽！"）。
3. 括号里的代号换成真名（沙=沙雕之歌、chi=chilian、亭=无木亭、N=Nipporita、F=Flying Craft），
   没在代号表里的（星、玄咒、薜荔…）原样保留。
4. 没有出题人括号的行（标题、"规则："、示例等）直接跳过；重复题目去重。

用法：
    python tools/docx_to_questions.py <docx 路径> [输出的 js 路径]
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# 代号 → 真名（docx 表头里写的名单）
AUTHORS = {
    "沙": "沙雕之歌",
    "chi": "chilian",
    "亭": "无木亭",
    "N": "Nipporita",
    "F": "Flying Craft",
}

# 已知出题人（含代号，用于判断"最后一对括号"是不是出题人）
KNOWN = set(AUTHORS) | set(AUTHORS.values()) | {"星", "玄咒", "薜荔", "wasted_", "无木亭"}

PAREN = re.compile(r"[（(]([^（()）]*)[)）]")


def docx_paragraphs(path: pathlib.Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    root = ET.fromstring(xml)
    lines = []
    for p in root.iter(W + "p"):
        buf = []
        for node in p.iter():
            if node.tag == W + "t" and node.text:
                buf.append(node.text)
            elif node.tag == W + "tab":
                buf.append(" ")
            elif node.tag == W + "br":
                buf.append(" ")
        lines.append("".join(buf))
    return lines


def clean(text: str) -> str:
    # 不做 NFKC：那会把「？。」换成半角，题目里的中文标点要保持原样。
    # 括号是全角还是半角，靠 PAREN 正则两种都认。
    return re.sub(r"\s+", " ", text).strip()


def parse_line(line: str):
    """返回 (题目正文, 出题人) ；不是题目行则返回 None"""
    text = clean(line)
    if not text:
        return None
    matches = list(PAREN.finditer(text))
    if not matches:
        return None
    last = matches[-1]
    author = clean(last.group(1))
    if author not in KNOWN:
        return None                      # 最后一对括号不是出题人 → 不当题目行
    question = text[: last.start()].strip(" 　:：-—")
    if not question:
        return None
    return question, AUTHORS.get(author, author)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else (
        pathlib.Path(__file__).resolve().parents[1] / "danmaku-frontend" / "fourth_righter_questions.js")

    questions, seen, skipped = [], set(), []
    for line in docx_paragraphs(src):
        parsed = parse_line(line)
        if not parsed:
            if clean(line):
                skipped.append(clean(line))
            continue
        question, author = parsed
        if question in seen:
            print("  [跳过] 重复题目：%s" % question)
            continue
        seen.add(question)
        questions.append({"text": question, "by": author})

    lines = [
        "// 互动环节 —— 主观问题池（由 tools/docx_to_questions.py 从出题 docx 生成，别手改）",
        "// 格式：{ text: 题目, by: 出题人 }；大屏会在题目下方显示「出题人：xxx」。",
        "// 想加题：直接往下面数组里加（by 可以留空字符串）；题目耗尽后会自动洗牌重来。",
        "// 重新生成：python tools/docx_to_questions.py \"D:\\\\Downloads\\\\主观题出题 (1).docx\"",
        "var allQuestions = [",
    ]
    for q in questions:
        lines.append("    { text: %s, by: %s }," % (json.dumps(q["text"], ensure_ascii=False),
                                                    json.dumps(q["by"], ensure_ascii=False)))
    lines.append("];")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("题目 %d 道 → %s" % (len(questions), out))
    authors = {}
    for q in questions:
        authors[q["by"]] = authors.get(q["by"], 0) + 1
    print("出题人分布：" + "、".join("%s %d 道" % (k, v) for k, v in sorted(authors.items(), key=lambda kv: -kv[1])))
    print("跳过的非题目行 %d 行：" % len(skipped))
    for s in skipped[:8]:
        print("   %s" % s[:60])
    return 0


if __name__ == "__main__":
    sys.exit(main())
