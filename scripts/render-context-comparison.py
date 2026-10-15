"""Render the checked-in mechanism example. Requires matplotlib; no API access."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'docs/context-comparison/illustrative.json').read_text())
assert data['kind'] == 'illustrative-not-measured'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 12,
                     'svg.fonttype': 'none', 'svg.hashsalt': 'dsh-block-ptc', 'axes.unicode_minus': False})
BG, INK, MUTED, GRID = '#f6f8fc', '#14263d', '#57697e', '#dce4ef'
HIT, MISS, ACCENT = '#4463b3', '#eaa45b', '#008574'
texts = {
 'en': {
  'eyebrow': 'MECHANISM EXAMPLE  /  ASSIGNED TOKEN WEIGHTS  /  NOT AN API BENCHMARK',
  'title': 'Same conversation. Smaller context after each completed block.',
  'sub': '12 requests · 4 tasks · 3 requests per task · identical user/tool workload in both arms',
  'baseline': 'PTC — history accumulates',
  'baseline_sub': 'Before the built-in automatic compaction threshold is reached',
  'block': 'Block PTC — summarize completed blocks',
  'block_sub': 'Summary runs inside R3, R6 and R9; the next request sees the replacement',
  'ylabel': 'Input context (thousands of assigned tokens)',
  'xlabel': 'Request in the same synthetic conversation',
  'hit': 'Modeled cache-hit tokens', 'miss': 'Modeled cache-miss tokens',
  'rebuild': 'Prefix rebuild',
  'note1': 'Full bar = total input context. Cached tokens still occupy the context window.',
  'note2': 'Replacing history can invalidate its cached suffix: R4, R7 and R10 visibly rebuild part of the prefix.',
  'note3': 'Fixed prefix 4,096 · each user message 256 · each assistant/tool pair 2,048 · each summary 512 tokens.',
  'note4': 'Closing in-flight pair and user messages stay. Ideal prefix cache only; no measured cost, latency or quality claim.',
 },
 'zh': {
  'eyebrow': '机制示意  /  人工指定 TOKEN 权重  /  非 API 实测',
  'title': '同一段对话：已完成的区块收口后，后续请求的上下文更小',
  'sub': '12 次请求 · 4 个任务 · 每个任务 3 次请求 · 两组使用相同的用户指令与工具工作量',
  'baseline': '原生 PTC — 历史持续累积',
  'baseline_sub': '本示例尚未触发内置自动压缩阈值',
  'block': 'Block PTC — 按已完成区块收口',
  'block_sub': 'R3、R6、R9 内提交摘要，下一次请求看到替换结果',
  'ylabel': '输入上下文（千个示意 token）',
  'xlabel': '同一段模拟对话中的请求序号',
  'hit': '模拟缓存命中 token', 'miss': '模拟缓存未命中 token',
  'rebuild': '前缀重建',
  'note1': '整根柱子 = 本次输入上下文。缓存命中的 token 仍占用上下文窗口。',
  'note2': '改写历史可能使后面的缓存前缀失效：R4、R7、R10 明确画出了重新构建的部分。',
  'note3': '固定前缀 4,096；每条用户消息 256；每对 assistant/tool 消息 2,048；每段摘要 512 token。',
  'note4': '保留用户消息及收口时尚未完成的调用。缓存采用理想前缀模型，不代表实测费用、速度或质量。',
 }
}
for lang, t in texts.items():
 if lang == 'zh':
  for candidate in ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']:
   if Path(candidate).exists():
    font_manager.fontManager.addfont(candidate)
    plt.rcParams['font.family'] = font_manager.FontProperties(fname=candidate).get_name()
    break
 else:
  plt.rcParams['font.family'] = 'DejaVu Sans'
 fig, axes = plt.subplots(1, 2, figsize=(17, 8.8), sharey=True)
 fig.patch.set_facecolor(BG)
 fig.subplots_adjust(left=.07, right=.98, top=.70, bottom=.29, wspace=.10)
 fig.text(.07,.945,t['eyebrow'],fontsize=11,color=ACCENT,weight='bold')
 fig.text(.07,.889,t['title'],fontsize=23,color=INK,weight='bold')
 fig.text(.07,.845,t['sub'],fontsize=12,color=MUTED)
 fig.legend(handles=[Patch(facecolor=HIT,label=t['hit']),Patch(facecolor=MISS,label=t['miss'])],
            loc='upper left',bbox_to_anchor=(.064,.814),ncol=2,frameon=False,fontsize=12)
 for index,(ax,series) in enumerate(zip(axes,[data['baseline'],data['blockPtc']])):
  ax.set_facecolor(BG)
  xs=[row['request'] for row in series]
  hits=[row['cacheHitTokens']/1000 for row in series]
  misses=[row['cacheMissTokens']/1000 for row in series]
  totals=[row['inputTokens']/1000 for row in series]
  ax.bar(xs,hits,color=HIT,width=.68,zorder=3)
  ax.bar(xs,misses,bottom=hits,color=MISS,width=.68,zorder=3)
  ax.set_ylim(0,32)
  ax.set_xlim(.3,12.7)
  ax.set_xticks(xs,[f'R{x}' for x in xs],fontsize=10)
  ax.set_yticks([0,8,16,24,32])
  ax.grid(axis='y',color=GRID,zorder=0)
  for spine in ax.spines.values(): spine.set_visible(False)
  ax.tick_params(axis='both',length=0,pad=8,labelcolor=MUTED)
  ax.set_xlabel(t['xlabel'],color=MUTED,labelpad=12,fontsize=11)
  ax.text(0,1.12,t['baseline'] if index==0 else t['block'],transform=ax.transAxes,fontsize=16,weight='bold',color=INK)
  ax.text(0,1.04,t['baseline_sub'] if index==0 else t['block_sub'],transform=ax.transAxes,fontsize=10,color=MUTED)
  for x,total in zip(xs,totals):
   ax.text(x,total+.42,f'{total:.1f}',ha='center',fontsize=8.5,color=INK)
  for boundary in [3.5,6.5,9.5]: ax.axvline(boundary,color=GRID,linestyle='--',linewidth=1,zorder=0)
  if index==1:
   for request in [4,7,10]:
    row=series[request-1]
    ax.annotate(t['rebuild'],xy=(request,row['inputTokens']/1000+.95),xytext=(request+.15,22),
                ha='center',fontsize=10,color=ACCENT,
                arrowprops={'arrowstyle':'->','color':ACCENT,'lw':1.2})
 axes[0].set_ylabel(t['ylabel'],color=MUTED,labelpad=10,fontsize=11)
 for y,key in zip([.184,.143,.102,.061],['note1','note2','note3','note4']):
  fig.text(.07,y,t[key],fontsize=11 if key in ['note1','note2'] else 10,color=INK if key=='note1' else MUTED)
 for ext in ['png','svg']:
  destination = ROOT/f'docs/assets/context-comparison.{lang}.{ext}'
  fig.savefig(destination,dpi=150,facecolor=BG,**({'metadata': {'Date': None}} if ext == 'svg' else {}))
  if ext == 'svg':
   destination.write_text('\n'.join(line.rstrip() for line in destination.read_text().splitlines()) + '\n')
 plt.close(fig)
print('Rendered English and Chinese PNG/SVG figures from illustrative.json.')
