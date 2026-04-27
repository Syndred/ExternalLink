"""
导入外链候选站：从 Markdown / CSV 文件提取域名信息写入 DB
支持格式：
  1. ViggoZ Startup-Launch-Directory 的 Markdown 表格
  2. Google Sheet 导出的 CSV
  3. 自定义 candidates.txt（域名|流量|DR|类型）
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from db import init_db, add_candidate


def parse_traffic(val: str) -> int:
    """解析流量字符串为数字"""
    val = val.strip()
    # 格式: "Traffic: 39.1K/m" or "Traffic: 1.3B/m" or "Traffic: <1/m"
    if '<1' in val:
        return 0
    m = re.search(r'([\d,.]+)\s*(K|M|B)?', val)
    if not m:
        return 0
    num = float(m.group(1).replace(',', ''))
    unit = m.group(2)
    if unit == 'K':
        num *= 1000
    elif unit == 'M':
        num *= 1_000_000
    elif unit == 'B':
        num *= 1_000_000_000
    return int(num)


def parse_da(val: str) -> float:
    """解析 DA 值"""
    m = re.search(r'([\d]+)', val)
    return float(m.group(1)) if m else 0


def import_viggoz_md(filepath: str, platform_type: str = 'saas_directory'):
    """导入 ViggoZ Startup-Launch-Directory 的 Markdown 表格"""
    content = Path(filepath).read_text(encoding='utf-8')
    lines = content.split('\n')

    # 格式: ||Name                          |Description...|Traffic: 39.1K/m|DA: 25|https://postmake.io/|
    # 数据行以 || 开头，列宽不定，用 |Traffic: 和 |DA: 作为锚点切分
    # 策略: 找到 |Traffic: 的位置 → 前半段是 Name+Desc → 后半段是 DA+URL
    count = 0
    skipped = 0

    for line in lines:
        line = line.strip()
        # 数据行以 | 开头，但跳过表头行和分隔行、空行
        if not line.startswith('|'):
            continue
        if line.startswith('| Name') or line.startswith('|-'):
            continue

        # 按 |Traffic: 切分
        if '|Traffic:' not in line:
            continue
        idx_t = line.index('|Traffic:')
        left = line[1:idx_t]          # 去掉开头的 "|"
        right = line[idx_t+1:]        # Traffic: ... |DA: ... |URL|

        # 左侧: Name | Description (按第一个 | 切)
        if '|' not in left:
            continue
        pipe_idx = left.index('|')
        name = left[:pipe_idx].strip()
        desc = left[pipe_idx+1:].strip()

        # 右侧: Traffic: X | DA: Y | URL
        parts = right.split('|')
        traffic_str = parts[0].replace('Traffic:', '').strip() if len(parts) > 0 else ''
        da_str = parts[1].replace('DA:', '').strip() if len(parts) > 1 else ''
        url = parts[2].strip() if len(parts) > 2 else ''

        # 清理 URL（去掉末尾的 |）
        url = url.rstrip('|')

        traffic = parse_traffic(traffic_str)
        da = parse_da(da_str)

        # 提取域名
        domain_m = re.search(r'https?://([^/]+)', url)
        domain = domain_m.group(1) if domain_m else url

        if traffic < 100:
            skipped += 1
            print(f"  [SKIP] {domain:40s} traffic={traffic:>8,d} DA={da:>4.0f}")
            continue

        add_candidate(
            domain=domain,
            traffic=traffic,
            dr=da,
            platform_type=platform_type,
            url=url,
            notes=f"Source: ViggoZ Directory | {name} | {desc[:80]}"
        )
        count += 1
        print(f"  [OK] {domain:40s} traffic={traffic:>10,d} DA={da:>4.0f}")

    return count, skipped


def import_custom_txt(filepath: str):
    """导入自定义 candidates.txt（域名|流量|DR|类型）"""
    content = Path(filepath).read_text(encoding='utf-8').strip()
    count = 0
    for line in content.split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('|')
        if len(parts) < 2:
            continue
        
        domain = parts[0].strip()
        traffic = int(parts[1]) if len(parts) > 1 and parts[1].strip().isdigit() else 0
        dr = float(parts[2]) if len(parts) > 2 else 0
        ptype = parts[3].strip() if len(parts) > 3 else 'unknown'
        url = parts[4].strip() if len(parts) > 4 else f'https://{domain}'
        
        add_candidate(domain=domain, traffic=traffic, dr=dr, platform_type=ptype, url=url)
        count += 1
    
    return count


def import_all():
    """导入内置的高价值外链目录（Google Sheet 数据本地化）"""
    # 这是从 Google Sheet 提取的高价值外链目录站（手动整理）
    # 原始 Source: https://docs.google.com/spreadsheets/d/1GSJRxpITbHjWz2edbCJlcabfZUiFgxMAVlROmee8UfQ
    high_value_sites = [
        # AI Tools Directories
        ("theresanaiforthat.com", 9600000, 71, "saas_directory", "https://theresanaiforthat.com/"),
        ("futuretools.io", 2200000, 45, "saas_directory", "https://www.futuretools.io/"),
        ("aitoolsdirectory.com", 290000, 35, "saas_directory", "https://aitoolsdirectory.com/"),
        ("topai.tools", 1500000, 42, "saas_directory", "https://topai.tools/"),
        ("futurepedia.io", 1800000, 52, "saas_directory", "https://www.futurepedia.io/"),
        ("toolify.ai", 980000, 48, "saas_directory", "https://www.toolify.ai/"),
        ("saasaitools.com", 120000, 28, "saas_directory", "https://saasaitools.com/"),
        ("aitoolnet.com", 180000, 25, "saas_directory", "https://www.aitoolnet.com/"),
        ("dang.ai", 340000, 38, "saas_directory", "https://dang.ai/"),
        ("insidr.ai", 95000, 22, "saas_directory", "https://www.insidr.ai/"),
        ("aitools.fyi", 280000, 33, "saas_directory", "https://aitools.fyi/"),
        ("whatsthebigdata.com", 250000, 40, "saas_directory", "https://whatsthebigdata.com/"),
        
        # Startup Directories (High Traffic)
        ("producthunt.com", 8500000, 88, "saas_directory", "https://www.producthunt.com/"),
        ("betapage.co", 280000, 32, "saas_directory", "https://betapage.co/"),
        ("startupbase.io", 420000, 28, "saas_directory", "https://startupbase.io/"),
        ("saashub.com", 1400000, 52, "saas_directory", "https://www.saashub.com/"),
        ("alternativeto.net", 4500000, 72, "saas_directory", "https://alternativeto.net/"),
        ("producthunt.com", 8500000, 88, "saas_directory", "https://www.producthunt.com/"),
        ("g2.com", 8000000, 78, "saas_directory", "https://www.g2.com/"),
        ("capterra.com", 6100000, 76, "saas_directory", "https://www.capterra.com/"),
        ("trustpilot.com", 15000000, 93, "saas_directory", "https://www.trustpilot.com/"),
        ("getapp.com", 3200000, 71, "saas_directory", "https://www.getapp.com/"),
        ("sourceforge.net", 18000000, 92, "saas_directory", "https://sourceforge.net/"),
        
        # Dev Blogs (Dofollow)
        ("dev.to", 11500000, 83, "blog", "https://dev.to/"),
        ("velog.io", 5000000, 65, "blog", "https://velog.io/"),
        ("telegra.ph", 8000000, 92, "blog", "https://telegra.ph/"),
        ("hashnode.com", 3200000, 68, "blog", "https://hashnode.com/"),
        ("medium.com", 150000000, 94, "blog", "https://medium.com/"),
        ("hackernoon.com", 1400000, 78, "blog", "https://hackernoon.com/"),
        ("codepen.io", 12000000, 91, "blog", "https://codepen.io/"),
        
        # Forum Profiles (Dofollow)
        ("phpbb.com", 1000000, 72, "forum_profile", "https://www.phpbb.com/"),
        
        # Additional directories from Google Sheet
        ("crazyaboutstartups.com", 8000, 18, "saas_directory", "https://crazyaboutstartups.com/"),
        ("startupbuffer.com", 15000, 16, "saas_directory", "https://startupbuffer.com/"),
        ("launchingnext.com", 45000, 35, "saas_directory", "https://www.launchingnext.com/"),
        ("sideprojectors.com", 25000, 22, "saas_directory", "https://www.sideprojectors.com/"),
        ("saasward.com", 8000, 15, "saas_directory", "https://saasward.com/"),
        ("pitchwall.co", 12000, 18, "saas_directory", "https://pitchwall.co/"),
        ("startupily.com", 5000, 12, "saas_directory", "https://startupily.com/"),
        ("startupjohn.com", 3000, 10, "saas_directory", "https://startupjohn.com/"),
        ("tooltester.com", 220000, 45, "saas_directory", "https://www.tooltester.com/"),
        ("saasgenius.com", 35000, 28, "saas_directory", "https://www.saasgenius.com/"),
        ("saasradar.com", 6000, 14, "saas_directory", "https://saasradar.com/"),
        ("ecommerce-platforms.com", 110000, 52, "saas_directory", "https://ecommerce-platforms.com/"),
        ("crozdesk.com", 140000, 48, "saas_directory", "https://crozdesk.com/"),
    ]
    
    count = 0
    for domain, traffic, dr, ptype, url in high_value_sites:
        add_candidate(domain=domain, traffic=traffic, dr=dr, platform_type=ptype, url=url)
        count += 1
    
    return count


if __name__ == '__main__':
    init_db()
    total = 0
    
    # 1. 导入 ViggoZ Startup Directories
    path1 = Path(__file__).parent.parent / "data_startup_directories.md"
    if path1.exists():
        print(f"\n[Importing] ViggoZ Startup Directories ({path1})")
        n, skipped = import_viggoz_md(str(path1), 'saas_directory')
        total += n
        print(f"  -> Imported {n}, Skipped {skipped} (traffic < 100)")
    
    # 2. 导入高价值外链目录（Google Sheet 数据本地化）
    print(f"\n[Importing] High-Value Backlink Directories (from Google Sheet)")
    n = import_all()
    total += n
    print(f"  -> Imported {n}")
    
    # 3. 检查是否有自定义 candidates.txt
    custom_path = Path(__file__).parent.parent / "candidates.txt"
    if custom_path.exists():
        print(f"\n[Importing] Custom candidates.txt ({custom_path})")
        n = import_custom_txt(str(custom_path))
        total += n
        print(f"  -> Imported {n}")
    
    print(f"\n{'='*60}")
    print(f"[DONE] Total imported: {total} candidates")
    print(f"[TIP]  Run 'python main.py list' to view all entries")