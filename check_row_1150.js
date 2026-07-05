const fs = require('fs');

async function main() {
  const url = "https://docs.google.com/spreadsheets/d/1w11kuIGWOVATOad5acQqVWSzELF25xCyP6j3yoBiEUc/gviz/tq?tqx=out:json&gid=0";
  try {
    const res = await fetch(url);
    const text = await res.text();
    const jsonString = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const json = JSON.parse(jsonString);
    const rows = json.table.rows;
    
    console.log(`Total rows: ${rows.length}`);
    
    let logOutput = "";
    // Log rows from index 1130 to 1170
    for (let rIdx = 1130; rIdx < Math.min(rows.length, 1170); rIdx++) {
      const row = rows[rIdx];
      logOutput += `\n--- Row Index ${rIdx} (Row Number ${rIdx + 1}) ---\n`;
      if (row && row.c) {
        row.c.forEach((cell, cIdx) => {
          const val = cell ? cell.v : null;
          logOutput += `  Col ${cIdx}: "${val}"\n`;
        });
      } else {
        logOutput += `  (Empty Row)\n`;
      }
    }
    
    fs.writeFileSync('row_1150_check.log', logOutput);
    console.log("Done checking rows 1130 to 1170. Written to row_1150_check.log");
  } catch (e) {
    console.error("Error:", e.message);
  }
}

main();
