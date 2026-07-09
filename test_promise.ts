import { delay } from "@std/async";

try {
  (async () => {
    await delay(300);
    console.log("Bye");
    throw new Error("No");
  })().catch((err) => {
    throw err;
  });
} catch (err) {
  console.log(err);
}

console.log("good");
