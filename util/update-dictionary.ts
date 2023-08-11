import { readFile, writeFile } from "fs/promises";
import _ from "lodash";
const { chain } = _;

const dictionaryFileName = `./src/dictionaries/${process.argv[2]}.txt`;
let dictionary: Buffer | undefined;
try {
    dictionary = await readFile(dictionaryFileName);
}
catch (err) {

}

const words = JSON.parse((await readFile(process.argv[3])).toString()) as Record<string, Boolean>;

const newDictionary = chain(dictionary?.length ? dictionary.toString() : "")
    .split("\n")
    .concat(chain(words)
        .toPairs()
        .filter(pair => pair[1] === true)
        .map(pair => pair[0])
        .value())
    .uniq()
    .orderBy()
    .join("\n")
    .value();

await writeFile(dictionaryFileName, newDictionary);
    