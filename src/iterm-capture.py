#!/usr/bin/env python3
"""
用 iTerm2 Python API 截取终端内容，生成 HTML 文件。
不依赖屏幕状态，锁屏也能用。

用法: python3 iterm-capture.py <session_name> <output.html>
"""
import iterm2
import asyncio
import sys
import html

session_name = sys.argv[1] if len(sys.argv) > 1 else ""
output_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-orchestrator/capture.html"

ANSI_COLORS = [
    "#1e1e2e", "#f38ba8", "#a6e3a1", "#f9e2af",
    "#89b4fa", "#cba6f7", "#94e2d5", "#cdd6f4",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
    "#89b4fa", "#cba6f7", "#94e2d5", "#ffffff",
]
DEFAULT_FG = "#cdd6f4"
DEFAULT_BG = "#1e1e2e"

def color_to_css(color, default):
    """iterm2 CellStyle.Color → CSS color string"""
    if color is None:
        return default
    if color.is_rgb:
        c = color.rgb
        return f"rgb({int(c.red*255)},{int(c.green*255)},{int(c.blue*255)})"
    if color.is_standard:
        idx = color.standard
        if 0 <= idx < len(ANSI_COLORS):
            return ANSI_COLORS[idx]
    return default

async def main(connection):
    app = await iterm2.async_get_app(connection)
    window = app.current_window
    if not window:
        print("ERROR: no window")
        return

    # 找目标 session
    target = None
    for tab in window.tabs:
        s = tab.current_session
        name = await s.async_get_variable("name") or ""
        if session_name and session_name.lower() in name.lower():
            target = s
            await tab.async_select()
            break

    if not target:
        target = window.current_tab.current_session

    # 获取屏幕内容
    contents = await target.async_get_screen_contents()

    # 构建 HTML
    lines_html = []
    for i in range(contents.number_of_lines):
        line = contents.line(i)
        line_str = line.string
        if not line_str:
            lines_html.append("")
            continue

        spans = []
        j = 0
        while j < len(line_str):
            style = line.style_at(j)
            fg = color_to_css(style.fg_color, DEFAULT_FG)
            bg = color_to_css(style.bg_color, DEFAULT_BG)
            bold = style.bold

            # 收集连续相同样式的字符
            text = line_str[j]
            k = j + 1
            while k < len(line_str):
                next_style = line.style_at(k)
                if (color_to_css(next_style.fg_color, DEFAULT_FG) == fg and
                    color_to_css(next_style.bg_color, DEFAULT_BG) == bg and
                    next_style.bold == bold):
                    text += line_str[k]
                    k += 1
                else:
                    break
            j = k

            escaped = html.escape(text)
            weight = "bold" if bold else "normal"
            spans.append(f'<span style="color:{fg};background:{bg};font-weight:{weight}">{escaped}</span>')

        lines_html.append("".join(spans))

    body = "<br>\n".join(lines_html)

    html_content = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body {{
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.4;
    padding: 16px;
    margin: 0;
    white-space: pre;
}}
</style></head>
<body>{body}</body>
</html>"""

    with open(output_path, "w") as f:
        f.write(html_content)
    print("OK")

asyncio.run(iterm2.run_until_complete(main))
