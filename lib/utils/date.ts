import { format } from "@std/datetime";

export const mojDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+\d{4}/;

export function convToMojDate(date: Date): string {
  let string = format(date, "yyyy-MM-dd HH:mm:ss ");

  if (date.getTimezoneOffset() < 0) {
    string += "+";
  } else {
    string += "-";
  }

  const offset = Math.abs(date.getTimezoneOffset());
  const hour = Math.floor(offset / 60);
  const minute = offset % 60;

  string +=
    hour.toString().padStart(2, "0") + minute.toString().padStart(2, "0");
  return string;
}

export function parseMojDate(input: string): Date {
  return new Date(input);
}
