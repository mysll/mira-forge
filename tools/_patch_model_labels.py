import pathlib

p = pathlib.Path("components/FeedCard.tsx")
s = p.read_text(encoding="utf-8")
s = s.replace('第 {position} {props.item.image?.media_type === "video" ? "条" : "张"} · {props.modelLabels?.[generation.model_name] ?? generation.model_name}',
              '第 {position} {props.item.image?.media_type === "video" ? "条" : "张"} · {modelLabel(generation.model_name, props.modelLabels)}')
if 'modelLabel' not in s.split('\n')[0] and 'from "@/lib/models"' not in s:
    s = s.replace('import { useComposerStore } from "@/stores/composer";', 'import { modelLabel } from "@/lib/models";\nimport { useComposerStore } from "@/stores/composer";', 1)
p.write_text(s, encoding="utf-8")

p = pathlib.Path("components/ImageDetail.tsx")
s = p.read_text(encoding="utf-8")
s = s.replace('<Row label="模型" value={modelLabels?.[generation.model_name] ?? generation.model_name} />',
              '<Row label="模型" value={modelLabel(generation.model_name, modelLabels)} />')
if 'from "@/lib/models"' not in s:
    s = s.replace('import { formatBytes, formatTime } from "@/lib/date";', 'import { formatBytes, formatTime } from "@/lib/date";\nimport { modelLabel } from "@/lib/models";', 1)
p.write_text(s, encoding="utf-8")
print("ok")
