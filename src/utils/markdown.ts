export function markdownToHtml(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let result = "";
  let i = 0;
  const len = html.length;
  const stack: string[] = [];

  while (i < len) {
    if (html.startsWith("```", i)) {
      if (stack.includes("pre")) {
        while (stack.length > 0) {
          const top = stack.pop();
          result += `</${top}>`;
          if (top === "pre") break;
        }
      } else {
        result += "<pre><code>";
        stack.push("pre", "code");
      }
      i += 3;
      continue;
    }

    if (stack.includes("pre")) {
      result += html[i];
      i++;
      continue;
    }

    if (html[i] === "`") {
      if (stack.includes("code")) {
        while (stack.length > 0) {
          const top = stack.pop();
          result += `</${top}>`;
          if (top === "code") break;
        }
      } else {
        result += "<code>";
        stack.push("code");
      }
      i++;
      continue;
    }

    if (stack.includes("code")) {
      result += html[i];
      i++;
      continue;
    }

    if (html.startsWith("**", i)) {
      if (stack.includes("b_ast")) {
        while (stack.length > 0) {
          const top = stack.pop();
          if (top === "b_ast") {
            result += "</b>";
            break;
          } else {
            result += `</${top === "i_ast" ? "i" : top === "i_und" ? "i" : top === "b_und" ? "b" : top}>`;
          }
        }
      } else {
        result += "<b>";
        stack.push("b_ast");
      }
      i += 2;
      continue;
    }

    if (html.startsWith("__", i)) {
      if (stack.includes("b_und")) {
        while (stack.length > 0) {
          const top = stack.pop();
          if (top === "b_und") {
            result += "</b>";
            break;
          } else {
            result += `</${top === "i_ast" ? "i" : top === "i_und" ? "i" : top === "b_ast" ? "b" : top}>`;
          }
        }
      } else {
        result += "<b>";
        stack.push("b_und");
      }
      i += 2;
      continue;
    }

    if (html[i] === "*") {
      if (stack.includes("i_ast")) {
        while (stack.length > 0) {
          const top = stack.pop();
          if (top === "i_ast") {
            result += "</i>";
            break;
          } else {
            result += `</${top === "i_und" ? "i" : top === "b_ast" ? "b" : top === "b_und" ? "b" : top}>`;
          }
        }
      } else {
        result += "<i>";
        stack.push("i_ast");
      }
      i++;
      continue;
    }

    if (html[i] === "_") {
      if (stack.includes("i_und")) {
        while (stack.length > 0) {
          const top = stack.pop();
          if (top === "i_und") {
            result += "</i>";
            break;
          } else {
            result += `</${top === "i_ast" ? "i" : top === "b_ast" ? "b" : top === "b_und" ? "b" : top}>`;
          }
        }
      } else {
        result += "<i>";
        stack.push("i_und");
      }
      i++;
      continue;
    }

    result += html[i];
    i++;
  }

  for (let j = stack.length - 1; j >= 0; j--) {
    const tag = stack[j];
    if (tag === "b_ast" || tag === "b_und") {
      result += "</b>";
    } else if (tag === "i_ast" || tag === "i_und") {
      result += "</i>";
    } else {
      result += `</${tag}>`;
    }
  }

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
}
