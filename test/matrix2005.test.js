'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('RDL 2005 <Matrix> parses and renders with subtotals', () => {
  const { parseRdl } = require('../src/rdl/parser');
  const { renderGrid, displayOf } = require('../src/rdl/engine');
  const tb=(n,v)=>`<Textbox Name="${n}"><Value>${v}</Value></Textbox>`;
  const xml=`<?xml version="1.0"?><Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2005/01/reportdefinition"><DataSources><DataSource Name="D"><DataSourceReference>D</DataSourceReference></DataSource></DataSources>
  <DataSets><DataSet Name="S"><Query><DataSourceName>D</DataSourceName><CommandText>select 1</CommandText></Query><Fields><Field Name="SBU"><DataField>SBU</DataField></Field><Field Name="Cat"><DataField>Cat</DataField></Field><Field Name="Amt"><DataField>Amt</DataField></Field></Fields></DataSet></DataSets>
  <Body><ReportItems><Matrix Name="m"><Top>0in</Top>
  <CornerHeader><ReportItems>${tb('c','')}</ReportItems></CornerHeader>
  <ColumnGroupings><ColumnGrouping><Height>1in</Height><StaticColumns><StaticColumn><ReportItems>${tb('ch','Amount')}</ReportItems></StaticColumn></StaticColumns></ColumnGrouping></ColumnGroupings>
  <RowGroupings><RowGrouping><Width>1in</Width><DynamicRows><Grouping Name="g1"><GroupExpressions><GroupExpression>=Fields!SBU.Value</GroupExpression></GroupExpressions></Grouping><ReportItems>${tb('r1','=Fields!SBU.Value')}</ReportItems></DynamicRows></RowGrouping>
  <RowGrouping><Width>1in</Width><DynamicRows><Grouping Name="g2"><GroupExpressions><GroupExpression>=Fields!Cat.Value</GroupExpression></GroupExpressions></Grouping><ReportItems>${tb('r2','=Fields!Cat.Value')}</ReportItems><Subtotal><ReportItems>${tb('t','Total')}</ReportItems></Subtotal></DynamicRows></RowGrouping></RowGroupings>
  <MatrixColumns><MatrixColumn><Width>1in</Width></MatrixColumn></MatrixColumns>
  <MatrixRows><MatrixRow><Height>1in</Height><MatrixCells><MatrixCell><ReportItems>${tb('v','=Sum(Fields!Amt.Value)')}</ReportItems></MatrixCell></MatrixCells></MatrixRow></MatrixRows>
  </Matrix></ReportItems></Body></Report>`;
  
  const def = parseRdl(xml);
  assert.deepStrictEqual(def.errors, []);
  assert.ok(!def.warnings.some((w) => /Unsupported report items/.test(w)));
  const rows = [['A', 'x', 1], ['A', 'y', 2], ['B', 'x', 4]].map(([SBU, Cat, Amt]) => ({ SBU, Cat, Amt }));
  const g = renderGrid(def, rows, {}, {});
  assert.deepStrictEqual(g.rows.map((r) => r.cells.map((c) => displayOf(c)).join('|')),
    ['|Amount', 'A|x|1', '|y|2', '|Total|3', 'B|x|4', '|Total|4']);
});
