const JisonLex = require('jison-lex');
const ebnfParser = require('ebnf-parser');
const fs = require('fs');

/**
 *
 * @param {Array} terminals - An array with all terminal symbols in the grammar
 * @param {Object} productions
 * @param start - the start symbol of the grammar
 * @constructor
 */
function Grammar (terminals, productions, start) {
    this.terminals = terminals;
    this.productions = productions;
    this.start = start;
}

const emptyString = "€";
const EOF = "EOF"

/** Generate the FIRST-set for each token
 *
 * @param {Grammar} grammar
 * @returns {Object} - An Object where the tokens are the keys and the corresponding Sets are the values.
 */
function getTokenFirstSets (grammar) {
    let firsts = {}
    for (const terminal of grammar.terminals) {
        firsts[terminal] = new Set([terminal]);
    }
    Object.keys(grammar.productions).forEach(t => firsts[t] = new Set());
    let hasUpdated = true;
    while (hasUpdated) {
        hasUpdated = false;
        for (const symbol in grammar.productions) {
            const oldFirsts = new Set(firsts[symbol]);
            grammar.productions[symbol].forEach(production => {
                if (production === emptyString) {
                    firsts[symbol].add(emptyString);
                } else {
                    let hasEpsilon = false;
                    for (const token of production) {
                        firsts[symbol] = firsts[symbol].union(
                            firsts[token].difference(new Set([emptyString]))
                        );
                        hasEpsilon = firsts[token].has(emptyString);
                        if (!hasEpsilon) break;
                    }
                    if (hasEpsilon) firsts[symbol].add(emptyString);
                }
            })
            hasUpdated = hasUpdated || oldFirsts.symmetricDifference(firsts[symbol]).size !== 0;
        }
    }
    return firsts;
}

/** Generate the FIRST-set for a string
 *
 * @param {Array<String>|String} string
 * @param {Object} firsts
 * @returns {Set<String>}
 */
function getStringFirstSet (string, firsts) {
    if (string === emptyString) return new Set([emptyString]);
    let first = new Set();
    let hasEpsilon = false;
    for (const symbol of string) {
        hasEpsilon = firsts[symbol].has(emptyString);
        first = first.union(firsts[symbol].difference(new Set([emptyString])));
        if (!hasEpsilon) break;
    }
    if (hasEpsilon) first.add(emptyString);
    return first;
}

/** Generate the FOLLOW-set for each non-terminal symbol
 *
 * @param {Grammar} grammar
 * @param {Object} firsts
 * @returns {Object} - An Object where the tokens are the keys and the corresponding Sets are the values.
 */
function getFollowSets (grammar, firsts) {
    let follows = {};
    Object.keys(grammar.productions).forEach(t => follows[t] = new Set());
    follows[grammar.start] = new Set([EOF]);
    let hasUpdated = true;
    while (hasUpdated) {
        hasUpdated = false;
        for (const symbol in grammar.productions) {
            const productions = grammar.productions[symbol];
            productions.filter(p => p !== emptyString).forEach(production => {
                production.forEach((token, i) => {
                    const oldFollows = new Set(follows[token]);
                    if (grammar.terminals.includes(token)) { // no FOLLOW-set for terminals
                        return;
                    }
                    if (production[i + 1]) {
                        follows[token] = follows[token]
                            .union(getStringFirstSet(production.slice(i + 1), firsts))
                            .difference(new Set([emptyString]));
                    }
                    if (i === production.length - 1 ||
                        (production[i + 1] && getStringFirstSet(production.slice(i + 1), firsts).has(emptyString))) {
                        follows[token] = follows[token].union(follows[symbol]);
                    }
                    hasUpdated = hasUpdated || oldFollows.symmetricDifference(follows[token]).size !== 0;
                });
            });
        }
    }
    return follows;
}

/** Create a parse table for grammar using firsts and follows
 *
 * @param {Grammar} grammar
 * @param {Object} firsts
 * @param {Object} follows
 * @returns {Object<Object>} - the parse table, each non-terminal has a row, each terminal a column.
 * Access entries with parseTable[non-terminal][terminal].
 */
function getParseTable (grammar, firsts, follows) {
    let parseTable = {};
    for (const symbol in grammar.productions) {
        parseTable[symbol] = {};
        grammar.productions[symbol].forEach(production => {
            getStringFirstSet(production, firsts).forEach(token => {
                if (grammar.terminals.includes(token)) {
                    parseTable[symbol][token] = production;
                } else if (token === emptyString) {
                    follows[symbol].forEach((terminal) => {
                        parseTable[symbol][terminal] = production;
                    });
                }
            });

        });
    }
    return parseTable;
}

/** Parse (and lex) the input string according to the parseTable, the grammar and the lexerRules
 *
 * @param {String} input
 * @param {{}} parseTable
 * @param {Grammar} grammar
 * @param {String|Object} lexerRules
 * @returns {*[]} The parsing log
 */
function parse (input, parseTable, grammar, lexerRules) {
    let stack = [grammar.start, EOF];
    const sparqlLexer = new JisonLex(lexerRules);
    sparqlLexer.setInput(input);
    let x = stack[0];
    let log = [];
    let token = sparqlLexer.lex();
    while (x !== EOF) {
        log.push('stack: '+ stack)
        log.push('token: '+ token);
        if (x === token) {
            log.push(`Consumed ${x}`);
            stack.shift();
            token = sparqlLexer.lex();
        } else if (grammar.terminals.includes(x)) {
            log.push(`Unexpected token ${token}`);
            return log;
        } else if (!(parseTable[x] && parseTable[x][token])) {
            log.push(`Unexpected token ${token}`);
            return log;
        } else {
            const production = parseTable[x][token];
            log.push(`Applied ${x} --> ${production}`);
            stack.shift();
            if (production !== emptyString) stack = production.concat(stack);
        }
        x = stack[0];
    }
    log.push("success");
    return log;
}

function readGrammar(filePath) {
    const grammarInput = fs.readFileSync(filePath, 'utf8');
    const parsedGrammar = ebnfParser.parse(grammarInput);
    let symbols = new Set();
    let productions = {};
    for (const symbol in parsedGrammar.bnf) {
        productions[symbol] = [];
        parsedGrammar.bnf[symbol].forEach(production => {
            if (production === "") productions[symbol].push(emptyString);
            else {
                let prod = production.split(" ");
                prod.forEach(s => symbols.add(s));
                productions[symbol].push(prod);
            }
        });
    }
    const terminals = Array.from(symbols).filter(t => productions[t] === undefined);
    return new Grammar(
        terminals,
        productions,
        parsedGrammar.start,
    );
}

/** Left-factorizes the grammar in place
 *
 * @returns {Grammar}
 */
Grammar.prototype.leftFactorize = function () {
    let hasChanged = true;
    while (hasChanged) {
        hasChanged = false;
        for (const symbol in this.productions) {
            let productions = this.productions[symbol].filter(p => p !== emptyString);
            while (productions[0]) {
                const production = productions.shift();
                let samePrefix = [];
                productions.forEach(otherProd => {
                    if (otherProd.at(0) === production.at(0)) samePrefix.push(otherProd);
                });
                if(samePrefix.length === 0) continue;

                // determine the length of the prefix
                let i;
                for (i = 1; i < production.length; i++) {
                    if (!samePrefix.every(p => p[i] === production[i])) break;
                }

                samePrefix.unshift(production);
                const suffixProductions = samePrefix.map(p => p.slice(i)).map(p => (p.length === 0 ? "€" : p));
                const newSymbol = symbol + '_LF' + this.productions[symbol].indexOf(production);
                const newProductions = [
                    [...production.slice(0, i), newSymbol],
                    ...this.productions[symbol].filter(p => !samePrefix.includes(p))
                ]
                this.productions[newSymbol] = suffixProductions;
                this.productions[symbol] = newProductions;
                productions = productions.filter(p => !samePrefix.includes(p));
                hasChanged = true;
            }
        }
    }
    return this;
}


const grammar = readGrammar('./sparql.y');
const lexerRules = fs.readFileSync('./sparql.l', 'utf8');
grammar.leftFactorize();
const firsts = getTokenFirstSets(grammar);
const follows = getFollowSets(grammar, firsts);
const parseTable = getParseTable(grammar, firsts, follows);
const log = parse(`
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?qui_entity (SAMPLE(?name) as ?qui_name) (SAMPLE(?alias) as ?qui_alias) (SAMPLE(?count) as ?qui_count) WHERE {
{ SELECT ?qui_entity (COUNT(?qui_entity) AS ?count) WHERE {
?person wdt:P31 wd:Q5 .
?person rdfs:label ?qui_entity .
} GROUP BY ?qui_entity }
OPTIONAL { ?qui_entity @en@rdfs:label ?name }
BIND (?qui_entity AS ?alias)
FILTER (REGEX(STR(?name), "^Alber", "i") || REGEX(STR(?alias), "^Alber", "i"))} GROUP BY ?qui_entity ORDER BY DESC(?qui_count)
LIMIT 40
`, parseTable, grammar, lexerRules);
console.log(log.slice(-30));

// for jest
module.exports = { Grammar, getTokenFirstSets, getStringFirstSet, getFollowSets, getParseTable, parse, EOF };
