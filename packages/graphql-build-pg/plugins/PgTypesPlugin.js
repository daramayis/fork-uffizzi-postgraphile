const {
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  GraphQLEnumType,
  GraphQLObjectType,
  GraphQLInputObjectType,
  isInputType,
} = require("graphql");
const { types: pgTypes } = require("pg");

const pgRangeParser = {
  parse(str) {
    const parts = str.split(",");
    if (parts.length !== 2) {
      throw new Error("Invalid daterange");
    }

    return {
      start: parts[0]
        ? {
            inclusive: parts[0][0] === "[",
            value: parts[0].slice(1),
          }
        : null,
      end: parts[1]
        ? {
            inclusive: parts[1][parts[1].length - 1] === "]",
            value: parts[1].slice(0, -1),
          }
        : null,
    };
  },

  serialize({ start, end }) {
    const inclusivity = {
      true: "[]",
      false: "()",
    };

    return [
      start ? inclusivity[start.inclusive][0] + start.value : "[",
      end ? end.value + inclusivity[end.inclusive][1] : "]",
    ].join(",");
  },
};

const {
  GraphQLDate,
  GraphQLTime,
  GraphQLDateTime,
} = require("graphql-iso-date");

const upperFirst = require("lodash/upperFirst");
const camelcase = require("lodash/camelcase");

module.exports = function PgTypesPlugin(
  builder,
  { pgExtendedTypes = true, pgInflection: inflection }
) {
  builder.hook("build", build => {
    const {
      pgIntrospectionResultsByKind: introspectionResultsByKind,
      getTypeByName,
      addType,
      pgSql: sql,
    } = build;

    const GraphQLJSON = getTypeByName("JSON");
    const GraphQLUUID = getTypeByName("UUID");
    const gqlTypeByTypeId = Object.assign({}, build.pgGqlTypeByTypeId);
    const gqlInputTypeByTypeId = Object.assign(
      {},
      build.pgGqlInputTypeByTypeId
    );
    const pg2GqlMapper = {};
    const pg2gql = (val, type) => {
      if (val == null) {
        return val;
      }
      if (pg2GqlMapper[type.id]) {
        return pg2GqlMapper[type.id].map(val);
      } else {
        return val;
      }
    };
    const gql2pg = (val, type) => {
      if (val == null) {
        return sql.null;
      }
      if (pg2GqlMapper[type.id]) {
        return pg2GqlMapper[type.id].unmap(val);
      } else {
        return sql.value(val);
      }
    };
    /*
      type =
        { kind: 'type',
          id: '1021',
          name: '_float4',
          description: null,
          namespaceId: '11',
          namespaceName: 'pg_catalog',
          type: 'b',
          category: 'A',
          domainIsNotNull: false,
          arrayItemTypeId: '700',
          classId: null,
          domainBaseTypeId: null,
          enumVariants: null,
          rangeSubTypeId: null }
      */
    const pgTypeById = introspectionResultsByKind.type.reduce((memo, type) => {
      memo[type.id] = type;
      return memo;
    }, {});
    const categoryLookup = {
      B: () => GraphQLBoolean,
      N: () => GraphQLFloat,
      A: type =>
        new GraphQLList(
          new GraphQLNonNull(
            enforceGqlTypeByPgType(pgTypeById[type.arrayItemTypeId])
          )
        ),
    };
    /*
        Determined by running:

          select oid, typname, typarray, typcategory, typtype from pg_catalog.pg_type where typtype = 'b' order by oid;

        We only need to add oidLookups for types that don't have the correct fallback
      */
    const oidLookup = Object.assign(
      {
        20: GraphQLString, // Even though this is int8, it's too big for JS int, so cast to string.
        21: GraphQLInt,
        23: GraphQLInt,
        790: GraphQLFloat, // money
      },
      pgExtendedTypes && {
        114: GraphQLJSON,
        3802: GraphQLJSON,
        2950: GraphQLUUID,
        1082: GraphQLDate, // date
        1114: GraphQLDateTime, // timestamp
        1184: GraphQLDateTime, // timestamptz
        1083: GraphQLTime, // time
        1266: GraphQLTime, // timetz
        // 1186 interval
      }
    );
    const identity = _ => _;
    const jsonStringify = o => JSON.stringify(o);
    if (pgExtendedTypes) {
      pg2GqlMapper[114] = {
        map: identity,
        unmap: o => sql.value(jsonStringify(o)),
      };
    } else {
      pg2GqlMapper[114] = {
        map: jsonStringify,
        unmap: o => sql.value(jsonStringify(o)),
      };
    }
    pg2GqlMapper[3802] = pg2GqlMapper[114]; // jsonb

    const parseMoney = str => {
      const numerical = str.replace(/[^0-9.,]/g, "");
      const lastCommaIndex = numerical.lastIndexOf(",");
      if (lastCommaIndex >= 0 && lastCommaIndex === numerical.length - 3) {
        // Assume string is of the form '123.456,78'
        return parseFloat(numerical.replace(/\./g, "").replace(",", "."));
      } else {
        // Assume string is of the form '123,456.78'
        return parseFloat(numerical.replace(/,/g, ""));
      }
    };
    pg2GqlMapper[790] = {
      map: parseMoney,
      unmap: val => sql.value(val),
    };
    const enforceGqlTypeByPgType = type => {
      // Explicit overrides
      if (!gqlTypeByTypeId[type.id]) {
        const gqlType = oidLookup[type.id];
        if (gqlType) {
          gqlTypeByTypeId[type.id] = gqlType;
        }
      }
      // Enums
      if (!gqlTypeByTypeId[type.id] && type.type === "e") {
        gqlTypeByTypeId[type.id] = new GraphQLEnumType({
          // XXX: use inflection
          name: upperFirst(camelcase(`${type.name}-enum`)),
          values: type.enumVariants.reduce((memo, value) => {
            memo[inflection.enumName(value)] = {
              name: value,
              value: value,
            };
            return memo;
          }, {}),
          description: type.description,
        });
      }
      // Ranges
      if (!gqlTypeByTypeId[type.id] && type.type === "r") {
        const subtype =
          introspectionResultsByKind.typeById[type.rangeSubTypeId];
        const gqlRangeSubType = enforceGqlTypeByPgType(subtype);
        if (!gqlRangeSubType) {
          throw new Error("Range of unsupported");
        }
        let Range = getTypeByName(inflection.rangeType(gqlRangeSubType.name));
        let RangeInput;
        if (!Range) {
          const RangeBound = new GraphQLObjectType({
            name: inflection.rangeBoundType(gqlRangeSubType.name),
            fields: {
              value: {
                type: new GraphQLNonNull(gqlRangeSubType),
              },
              inclusive: {
                type: new GraphQLNonNull(GraphQLBoolean),
              },
            },
          });
          const RangeBoundInput = new GraphQLInputObjectType({
            name: inflection.inputType(RangeBound.name),
            fields: {
              value: {
                type: new GraphQLNonNull(gqlRangeSubType),
              },
              inclusive: {
                type: new GraphQLNonNull(GraphQLBoolean),
              },
            },
          });
          Range = new GraphQLObjectType({
            name: inflection.rangeType(gqlRangeSubType.name),
            fields: {
              start: {
                type: RangeBound,
              },
              end: {
                type: RangeBound,
              },
            },
          });
          RangeInput = new GraphQLInputObjectType({
            name: inflection.inputType(Range.name),
            fields: {
              start: {
                type: RangeBoundInput,
              },
              end: {
                type: RangeBoundInput,
              },
            },
          });
          addType(Range);
          addType(RangeInput);
        } else {
          RangeInput = getTypeByName(inflection.inputType(Range.name));
        }
        gqlTypeByTypeId[type.id] = Range;
        gqlInputTypeByTypeId[type.id] = RangeInput;
        pg2GqlMapper[type.id] = {
          map: pgRange => {
            const parsed = pgRangeParser.parse(pgRange);
            // Since the value we will get from `parsed.(start|end).value` is a
            // string but our code will expect it to be the value after `pg`
            // parsed it, we pass through to `pg-types` for parsing.
            const pgParse = pgTypes.getTypeParser(subtype.id);
            return {
              start: parsed.start && {
                value: pg2gql(pgParse(parsed.start.value), subtype),
                inclusive: parsed.start.inclusive,
              },
              end: parsed.end && {
                value: pg2gql(pgParse(parsed.end.value), subtype),
                inclusive: parsed.end.inclusive,
              },
            };
          },
          unmap: ({ start, end }) => {
            // Ref: https://www.postgresql.org/docs/9.6/static/rangetypes.html#RANGETYPES-CONSTRUCT
            const lower = (start && gql2pg(start.value, subtype)) || sql.null;
            const upper = (end && gql2pg(end.value, subtype)) || sql.null;
            const lowerInclusive = start && !start.inclusive ? "(" : "[";
            const upperInclusive = end && !end.inclusive ? ")" : "]";
            return sql.fragment`${sql.identifier(
              type.namespaceName,
              type.name
            )}(${lower}, ${upper}, ${sql.literal(
              lowerInclusive + upperInclusive
            )})`;
          },
        };
      }
      // Fall back to categories
      if (!gqlTypeByTypeId[type.id]) {
        const gen = categoryLookup[type.category];
        if (gen) {
          gqlTypeByTypeId[type.id] = gen(type);
        }
      }
      // Nothing else worked; pass through as string!
      if (!gqlTypeByTypeId[type.id]) {
        gqlTypeByTypeId[type.id] = GraphQLString;
      }
      // Now for input types, fall back to output types if possible
      if (!gqlInputTypeByTypeId[type.id]) {
        if (isInputType(gqlTypeByTypeId[type.id])) {
          gqlInputTypeByTypeId[type.id] = gqlTypeByTypeId[type.id];
        }
      }
      return gqlTypeByTypeId[type.id];
    };

    introspectionResultsByKind.type.forEach(enforceGqlTypeByPgType);

    return build.extend(build, {
      pgGqlTypeByTypeId: gqlTypeByTypeId,
      pgGqlInputTypeByTypeId: gqlInputTypeByTypeId,
      pg2GqlMapper,
      pg2gql,
      gql2pg,
    });
  });
};