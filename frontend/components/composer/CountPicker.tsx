"use client";

import CountMenu from "@/components/CountMenu";
import Popover from "@/components/Popover";

/** 参数栏里的数量选择：图片/视频/分层/元素共用同一个菜单。 */
export default function CountPicker({
  value,
  options,
  unit,
  onChange,
  title,
}: {
  value: number;
  options: number[];
  unit: string;
  onChange: (value: number) => void;
  title?: string;
}) {
  return (
    <Popover label={<span>数量 {value}</span>} title={title ?? `一次出几${unit}`} width={80}>
      {(close) => (
        <CountMenu
          options={options}
          value={value}
          unit={unit}
          onSelect={(option) => {
            onChange(option);
            close();
          }}
        />
      )}
    </Popover>
  );
}
