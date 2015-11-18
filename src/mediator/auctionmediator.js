/**
 * pubfood
 */

'use strict';

var util = require('../util');
var Slot = require('../model/slot');
var BidMediator = require('./bidmediator');
var BidAssembler = require('../assembler/bidassembler');
var RequestAssembler = require('../assembler/requestassembler');
var TransformOperator = require('../assembler/transformoperator');
var AuctionProvider = require('../provider/auctionprovider');
var BidProvider = require('../provider/bidprovider');
var Event = require('../event');

/**
 * AuctionMediator coordiates requests to Publisher Ad Servers.
 *
 * @class
 * @memberof pubfood#mediator
 * @private
 */
function AuctionMediator(config) {
  if (config && config.optionalId) {
    this.id = config.optionalId;
  }

  /** @property {boolean} prefix if false, do not add bid provider name to bid targeting key. Default: true */
  this.prefix = config && config.hasOwnProperty('prefix') ? config.prefix : true;
  this.bidCount = 0;
  this.totalBidProviders = 0;
  this.slots = [];
  // store slots by name for easy lookup
  this.slotMap = {};
  this.bidProviders = {};
  this.auctionProvider = null;
  this.bids_ = [];
  this.lateBids_ = [];
  this.inAuction = false;
  this.timeout_ = -1;
  this.trigger_ = null;
  this.initDoneTimeout_ = 2000;
  this.processTargetingCounter_ = 0;
  this.bidMediator = new BidMediator(this);
  this.bidAssembler = new BidAssembler();
  this.requestAssembler = new RequestAssembler();
}

/**
 * Initialize the auction
 *
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.init = function() {
  Event.on(Event.EVENT_TYPE.BID_COMPLETE, util.bind(this.checkBids_, this));
  Event.on(Event.EVENT_TYPE.BID_PUSH_NEXT, util.bind(this.pushBid_, this));
  Event.on(Event.EVENT_TYPE.AUCTION_TRIGGER, util.bind(this.triggerAuction_, this));
  return this;
};

/**
 * Validate provider and slot dependencies.
 *
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.validate = function(isRefresh) {
  var isValid = true;
  /* eslint-disable no-unused-vars */
  var refresh = isRefresh || false;
  /* eslint-enable no-unused-vars */

  var tst = {
    hasAuctionProvider: function () {
      return !!this.auctionProvider;
    },
    hasBidProviders: function() {
      var ret = false;
      /* eslint-disable no-unused-vars */
      for (var v in this.bidProviders) {
        ret = true;
        break;
      }
      /* eslint-enable no-unused-vars */
      if (!ret) {
        Event.publish(Event.EVENT_TYPE.WARN, {msg: 'Warn: no bid providers'});
      }
      return ret;
    },
    hasSlots: function() {
      return this.slots.length !== 0;
    },
    hasAllSlotsBidder: function() {
      var noBidders = [];
      for (var i = 0; i < this.slots.length; i++) {
        var slot = this.slots[i];
        if (!slot.bidProviders || !slot.bidProviders[0]) {
          noBidders.push(slot.name);
        }
      }
      if (noBidders.length > 0) {
        Event.publish(Event.EVENT_TYPE.WARN, {msg: 'Warn: no bidders - ' + noBidders.join(', ')});
      }
      return noBidders.length === 0;
    }
  };

  tst.hasBidProviders.warn = true;
  for (var k in tst) {
    isValid = tst[k].call(this);
    isValid = tst[k].warn ? true : isValid;
    if (!isValid) {
      Event.publish(Event.EVENT_TYPE.INVALID, {msg: 'Failed: ' + k});
      break;
    }
  }

  return isValid;
};

/**
 * Sets the time in which bid providers must supply bids.
 *
 * @param {number} millis - milliseconds to set the timeout
 */
AuctionMediator.prototype.timeout = function(millis) {
  this.timeout_ = typeof millis === 'number' ? millis : 2000;
};

/**
 * Gets the time in which bid providers must supply bids.
 *
 * @return {number} the timeout in milliseconds
 */
AuctionMediator.prototype.getTimeout = function() {
  return this.timeout_;
};

/**
 * The maximum time the auction provider has before calling `done` inside the `init` method
 *
 * @param {number} millis timeout in milliseconds
 */
AuctionMediator.prototype.setAuctionProviderCbTimeout = function(millis){
  this.initDoneTimeout_ = typeof millis === 'number' ? millis : 2000;
};

/**
 * Force auction provider to init.
 *
 * @param {object}  event
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.setAuctionTrigger = function(triggerFn) {
  this.trigger = triggerFn;
};

/**
 * @private
 */
AuctionMediator.prototype.startAuction_ = function() {
  Event.publish(Event.EVENT_TYPE.BID_ASSEMBLER, 'AuctionMediator');
  this.bidAssembler.process(this.bids_);
  this.go_();
};

/**
 * Start the bid provider timeout.
 * @private
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.startTimeout_ = function() {
  if (this.timeout_ !== -1 && this.timeout_ >= 0) {
    setTimeout(util.bind(this.startAuction_, this), this.timeout_);
  }
  return this;
};

/**
 * Force auction provider to init.
 * @private
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.triggerAuction_ = function() {
  if (!this.trigger) {
    this.startTimeout_();
    return;
  }

  function triggerAuction() {
    this.startAuction_();
  }

  this.trigger(util.bind(triggerAuction, this));

  return this;
};

/**
 * Adds bid on {pubfood.PubfoodEvent.BID_PUSH_NEXT} event.
 *
 * @param {object} event event object containing data payload
 * @private
 * @return {AuctionMediator}
 */
AuctionMediator.prototype.pushBid_ = function(event) {
  if (!this.inAuction) {
    var bid = event.data;
    this.bids_.push(bid);
  } else {
    this.lateBids_.push(event.data);
  }
  return this;
};

/**
 * Check the bid complete count.
 *
 * If all bidders are complete, start the auction.
 *
 * @private
 */
AuctionMediator.prototype.checkBids_ = function() {
  this.bidCount++;
  if (this.bidCount === this.totalBidProviders) {
    this.startAuction_();
  }
};

/**
 * Start the auction delegate.
 *
 * @private
 */
AuctionMediator.prototype.go_ = function() {
  if (!this.inAuction) {
    this.inAuction = true;
    this.processTargeting_();
  }
};

AuctionMediator.prototype.getBidKey = function(bid) {
  return (this.prefix && bid.provider ? bid.provider + '_' : '') + (bid.label || 'bid');
};

AuctionMediator.prototype.mergeKeys = function(slotTargeting, bidTargeting) {
  slotTargeting = util.mergeToObject(slotTargeting, bidTargeting);
};

/**
 * Get slot bids.
 *
 * @param {string} slotName name of the slot
 * @return {array} bids for the slot name
 * @private
 */
AuctionMediator.prototype.getSlotBids = function(slotName) {
  var slotBids = [];
  for (var i = 0; i < this.bids_.length; i++) {
    var b = this.bids_[i];
    if (b.slot && b.slot === slotName) {
      slotBids.push(b);
    }
  }
  return slotBids;
};

/**
 * Builds targeting objects for {AuctionDelegate} requests.
 * @private
 * @return {object[]} targeting objects
 */
AuctionMediator.prototype.buildTargeting_ = function() {
  var auctionTargeting = [];
  for (var i = 0; i < this.slots.length; i++) {
    var s = this.slots[i];
    var t = { type: 'slot',
              name: s.name,
              id: s.id,
              elementId: s.elementId || '',
              sizes: s.sizes,
              bids: [],
              targeting: {}
            };

    var slotBids = this.getSlotBids(s.name);
    for (var k = 0; k < slotBids.length; k++) {
      var bid = slotBids[k];
      t.bids.push({
        value: bid.value || '',
        provider: bid.provider,
        id: bid.id,
        targeting: bid.targeting
      });
      var bidKey = this.getBidKey(bid);
      t.targeting[bidKey] = t.targeting[bidKey] || (bid.value || '');
      this.mergeKeys(t.targeting, bid.targeting);
    }

    auctionTargeting.push(t);
  }
  return auctionTargeting;
};

/**
 * process the targeting for the auction provider
 * @private
 */
AuctionMediator.prototype.processTargeting_ = function() {
  var self = this;
  var doneCalled = false;
  var name = self.auctionProvider.name;
  self.processTargetingCounter_++;

  var doneCb = function() {
    if (!doneCalled) {
      doneCalled = true;
      self.auctionDone(name);
    }
  };

  setTimeout(function() {
    if (!doneCalled) {
      Event.publish(Event.EVENT_TYPE.WARN, 'Warning: The auction done callback for "' + name + '" hasn\'t been called within the allotted time (' + (self.initDoneTimeout_ / 1000) + 'sec)');
      doneCb();
    }
  }, self.initDoneTimeout_);

  Event.publish(Event.EVENT_TYPE.AUCTION_GO, name);

  var targeting = self.buildTargeting_();
  if (self.processTargetingCounter_ === 1) {
    self.auctionProvider.init(targeting, doneCb);
  } else {
    self.auctionProvider.refresh(targeting, doneCb);
  }
};

/**
 * Notification of auction complete
 *
 * @param {string} data The auction mediator's name
 * @fires pubfood.PubfoodEvent.AUCTION_COMPLETE
 */
AuctionMediator.prototype.auctionDone = function(data) {
  Event.publish(Event.EVENT_TYPE.AUCTION_COMPLETE, data);
  setTimeout(function() {
    // push this POST event onto the next tick of the event loop
    Event.publish(Event.EVENT_TYPE.AUCTION_POST_RUN, data);
    // TODO consider if delay should be zero or another default
    // TODO consider if delay should be tweakable
  }, 0);
};

/**
 * Add a [Slot]{@link pubfood#model.Slot} to [AuctionMediator]{@link pubfood#mediator.AuctionMediator} config.
 * @param {SlotConfig} slotConfig - configuration for a [Slot]{@link pubfood#model.Slot}
 * @returns {pubfood#mediator.AuctionMediator}
 */
AuctionMediator.prototype.addSlot = function(slotConfig) {
  var slot = Slot.fromObject(slotConfig);
  if (slot) {
    this.slots.push(slot);
    this.slotMap[slot.name] = slot;
  } else {
    Event.publish(Event.EVENT_TYPE.WARN, 'Invalid slot object: ' + JSON.stringify(slotConfig || {}));
  }
  return this;
};

/**
 * Add a [BidProvider]{@link pubfood#provider.BidProvider} configuration object.
 * @param {BidDelegate} delegateConfig - configuration for a [BidProvider]{@link pubfood#provider.BidProvider}
 * @returns {pubfood#provider.BidProvider}
 */
AuctionMediator.prototype.addBidProvider = function(delegateConfig) {

  var bidProvider = BidProvider.withDelegate(delegateConfig);
  if (bidProvider) {
    if(this.bidProviders[bidProvider.name]){
      Event.publish(Event.EVENT_TYPE.WARN, 'Warning: bid provider ' + bidProvider.name + ' is already added');
    } else {
      this.totalBidProviders++;
      this.bidProviders[bidProvider.name] = bidProvider;
    }
  } else {
    Event.publish(Event.EVENT_TYPE.WARN, 'Warning: invalid bid provider: ' + delegateConfig.name);
  }
  return bidProvider;
};

AuctionMediator.prototype.bidProviderExists_ = function(name){
  return !!this.bidProviders[name];
};

/**
 * The maximum time the bid provider has before calling `done` inside the `init` method
 *
 * @param {number} millis timeout in milliseconds
 */
AuctionMediator.prototype.setBidProviderCbTimeout = function(millis){
  this.bidMediator.setBidProviderCbTimeout(millis);
};

/**
 * Add a [AuctionProvider]{@link pubfood#provider.AuctionProvider} configuration object.
 * @param {AuctionDelegate} delegateConfig - configuration for a [AuctionProvider]{@link pubfood#provider.AuctionProvider}
 * @returns {null|pubfood#provider.AuctionProvider}
 */
AuctionMediator.prototype.setAuctionProvider = function(delegateConfig) {
  if (this.auctionProvider) {
    Event.publish(Event.EVENT_TYPE.WARN, 'Warning: auction provider exists: ' + this.auctionProvider.name);
  }
  var auctionProvider = AuctionProvider.withDelegate(delegateConfig);
  if(auctionProvider){
    this.auctionProvider = auctionProvider;
    this.auctionProvider.setMediator(this);
  } else {
    Event.publish(Event.EVENT_TYPE.WARN, 'Warning: invalid auction provider: ' + delegateConfig.name);
  }
  return auctionProvider;
};

/**
 * Adds a function to transform provider bid request parameters, before auction provider request
 *
 * @param {TransformDelegate} delegate the transformation delegate function
 * @returns {pubfood#mediator.AuctionMediator}
 */
AuctionMediator.prototype.addRequestTransform = function(delegate){
  this.requestAssembler.addOperator(new TransformOperator(delegate));
  return this;
};

/**
 * Adds a function to transform provider bid results.
 *
 * @param {TransformDelegate} delegate the transformation delegate function
 * @returns {pubfood#mediator.AuctionMediator}
 */
AuctionMediator.prototype.addBidTransform = function(delegate){
  this.bidAssembler.addOperator(new TransformOperator(delegate));
  return this;
};

/**
 * Load bid provider JavaScript library/tag.
 * @params {boolean} randomizeBidRequests
 */
AuctionMediator.prototype.loadProviders = function(randomizeBidRequests) {
  var uri;
  var keys = [];

  for (var bp in this.bidProviders) {
    keys.push(bp);
  }

  if (randomizeBidRequests) {
    util.randomize(keys);
  }

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (this.bidProviders[key].libUri) {
      uri = this.bidProviders[key].libUri() || '';
      var sync = this.bidProviders[key].sync();
      util.loadUri(uri, sync);
    }
  }

  if (this.auctionProvider && this.auctionProvider.libUri()) {
    Event.publish(Event.EVENT_TYPE.AUCTION_LIB_LOADED, this.auctionProvider.name);

    uri = this.auctionProvider.libUri();
    // @todo get sync going here
    util.loadUri(uri);
  }
};

/**
 * Construct a set of slots for bidders.
 *
 * @returns {BidderSlots[]} bidderSlots an object containing an array of slots for each bidder.
 *
 */
AuctionMediator.prototype.getBidderSlots = function() {
  var bidderSlots = {};
  var ret = [];
  var i, k;

  for (i = 0; i < this.slots.length; i++) {
    var slot = this.slots[i];
    for (k = 0; k < slot.bidProviders.length; k++) {
      var provider = slot.bidProviders[k];

      var bSlots = bidderSlots[provider] = bidderSlots[provider] || [];
      bSlots.push(slot);
    }
  }

  for (k in bidderSlots) {
    ret.push({provider: this.bidProviders[k], slots: bidderSlots[k]});
  }
  return ret;
};

/**
 * Start auction bidding.
 * @param {boolean} randomizeBidRequests
 * @returns {pubfood#mediator.AuctionMediator}
 */
AuctionMediator.prototype.start = function(randomizeBidRequests) {
  this.init();
  Event.publish(Event.EVENT_TYPE.AUCTION_TRIGGER, this.auctionProvider.name);

  this.loadProviders(randomizeBidRequests);

  var bidderSlots = this.getBidderSlots();

  this.bidMediator.processBids(bidderSlots);
  return this;
};

/**
 * Refresh bids for listed slot names.
 *
 * @param {string[]} slotNames slots to refresh
 * @returns {pubfood#mediator.AuctionMediator}
 */
AuctionMediator.prototype.refresh = function(slotNames) {
  if(!util.isArray(slotNames)){
    Event.publish(Event.EVENT_TYPE.WARN, 'Invalid data structure, "refresh" accepts an array of strings (slot names)');
  } else {
    var i, slot;
    var self = this;

    // reset the slots
    this.slots = [];

    for (i=0; i< slotNames.length; i++) {
      slot = slotNames[i];
      if(!this.slotMap[slot]){
        Event.publish(Event.EVENT_TYPE.WARN, 'Can\'t refresh slot "'+ slot +'", because it wasn\'t defined');
      } else {
        this.slots.push(this.slotMap[slot]);
      }
    }

    if(this.slots.length > 0) {
      var name = this.auctionProvider.name;
      Event.publish(Event.EVENT_TYPE.AUCTION_REFRESH, name);

      this.bids_ = [];
      this.lateBids_ = [];

      // trigger bid provider refresh
      var bidderSlots = this.getBidderSlots();
      this.bidMediator.processBids(bidderSlots);

      // trigger auction provider refresh
      var doneCalled = false;
      var doneCb = function() {
        if (!doneCalled) {
          doneCalled = true;
          self.auctionDone(name);
        }
      };

      setTimeout(function(){
        if (!doneCalled) {
          Event.publish(Event.EVENT_TYPE.WARN, 'Warning: The auction done callback for "'+name+'" hasn\'t been called within the allotted time (' + (self.initDoneTimeout_/1000) + 'sec)');
          doneCb();
        }
      }, this.initDoneTimeout_);

      var targeting = this.buildTargeting_();
      this.auctionProvider.refresh(targeting, doneCb);
    }
  }
  return this;
};

module.exports = AuctionMediator;
