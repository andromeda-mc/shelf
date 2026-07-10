import { format } from "@std/datetime";
import { sprintf } from "@std/fmt/printf";

export function getMojDate(date: Date): string {
  let string = format(date, "yyyy-MM-dd HH:mm:ss ");

  if (date.getTimezoneOffset() < 0) {
    string += "+";
  } else {
    string += "-";
  }

  const offset = Math.abs(date.getTimezoneOffset());
  const hour = Math.floor(offset / 60);
  const minute = offset % 60;

  string += sprintf("%02d%02d", hour, minute);
  return string;
}

export function parseMojDate(input: string): Date {
  return new Date(input);
}
