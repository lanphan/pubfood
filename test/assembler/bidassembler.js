/**
 * pubfood
 */

'use strict';

/*eslint no-unused-vars: 0*/
/*eslint no-undef: 0*/
var assert = require('chai').assert;
var BidAssembler = require('../../src/assembler/bidassembler');
var TransformOperator = require('../../src/assembler/transformoperator');
var Bid = require('../../src/model/bid');

describe('BidAssembler', function testBidAssembler() {

  var BIDS  = [
    {
      sizes: [300, 250],
      slot: '1',
      value: 1
    },
    {
      targeting: {
      },
      sizes: [300, 250],
      slot: '/this/is/a/slot',
      value: '1'
    },
    {
      targeting: {
        yes: 'yes',
      },
      sizes: [[300, 600], [300, 250]],
      slot: '/this/is/a/slot',
      value: 1
    },
    {
      targeting: {
        no: 'no'
      },
      sizes: [[728, 90]],
      slot: '/this/is/a/slot',
      value: .2
    },
    {
      targeting: {
        yes: 'yes'
      },
      sizes: [300, 250],
      slot: '/this/is/a/slot',
      value: '1.75'
    }
  ];

  it('should add a transform operator', function() {
    var assembler = new BidAssembler();

    function transform(bids, params) {
      console.log('transform1');
      return bids;
    }
    assembler.addOperator(transform);
    assert.isTrue(transform === assembler.operators[0], 'transforms not equal');
  });

  it('should process an object property', function() {
    var assembler = new BidAssembler();

    function transform(bids, params) {
      for (var i = 0; i < bids.length; i++) {
        bids[i].value = parseInt(bids[i].value) + 1;
      }
      return bids;
    }
    assembler.addOperator(new TransformOperator(transform));
    var bids = assembler.process([{value: '12'}]);
    assert.isTrue(bids[0].value === 13, 'bid value not transformed');
  });

  it('should process array of bids', function() {
    var assembler = new BidAssembler();

    function noop(bid, params) {
    }
    assembler.addOperator(new TransformOperator(noop));

    var bids = assembler.process(BIDS);

  });


  it('should run process on >1 operators', function() {
    var inBids = [];
    for (var k = 0; k < BIDS.length; k++) {
      inBids.push(Bid.fromObject(BIDS[k]));
    }

    var assembler = new BidAssembler();

    function rankOperator(b1, b2)
    {
      var v1 = b1.value;
      var v2 = b2.value;
      var ret = 0;
      if (v1 > v2) ret = -1;
      if (v1 < v2) ret = 1;
      return ret;
    }
    function rank(bids, params) {
      return bids.sort(rankOperator);
    }
    function filter(bids, params) {
      var filteredBids = [];
      for (var k = 0; k < bids.length; k++) {
        if (bids[k].targeting && bids[k].targeting.yes && bids[k].targeting.yes === 'yes') {
          bids[k].value = parseFloat(bids[k].value);
          filteredBids.push(bids[k]);
        }
      }
      return filteredBids;
    }

    assembler.addOperator(new TransformOperator(filter));
    assembler.addOperator(new TransformOperator(rank));
    var outBids = assembler.process(inBids);

    assert.isTrue(outBids[0].value === 1.75);
  });

});
