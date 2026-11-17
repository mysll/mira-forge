import pathlib
p = pathlib.Path("components/editor/EditorPanel.tsx")
s = p.read_text(encoding="utf-8")

s = s.replace('''import type { EditorAnalysis } from "@/lib/api";''', '''import type { EditorAnalysis, LocalEditSaved } from "@/lib/api";''')

s = s.replace('''  onExport: () => void;
  onReplace: () => void;
};''', '''  onExport: () => void;
  onSave: () => void;
  saving: boolean;
  saved: LocalEditSaved | null;
  onReplace: () => void;
};''')

s = s.replace('''  onExport,
  onReplace,
''', '''  onExport,
  onSave,
  saving,
  saved,
  onReplace,
''')

s = s.replace('''        <button type="button" className="btn-ghost w-full py-1.5 text-[11px]" onClick={onReplace}>
          换一张图
        </button>''', '''        <button
          type="button"
          className="btn-ghost w-full py-1.5 text-[11px]"
          onClick={onSave}
          disabled={!subject || saving}
        >
          {saving ? "正在保存…" : `保存到资产 · ${output.width}×${output.height}`}
        </button>
        <p className="text-[10px] leading-relaxed text-muted/70">
          保存会在资产库生成一条「本地编辑」记录，和生成图一样能收藏、下载、删除；原图不受影响。
        </p>
        {saved ? (
          <p className="rounded-md border border-ok/40 bg-ok/10 px-2 py-1.5 text-[11px] leading-relaxed text-ok">
            已保存为批次 #{saved.generation_id} · 图 #{saved.image_id}（{saved.width}×{saved.height}）
          </p>
        ) : null}
        <button type="button" className="btn-ghost w-full py-1.5 text-[11px]" onClick={onReplace}>
          换一张图
        </button>''')

p.write_text(s, encoding="utf-8")
print("ok")
