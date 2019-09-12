const DUSTLIMIT = 546;
const MAXPOSSNUMBEROFINPUTS = 10;
const Buffer = buffer.Buffer;
const BITBOX = bitboxSdk;
let extraSatoshis=5;
let miningFeeMultiplier = 1;



class TransactionQueue {

  // compose script
  _script(opcode, options) {
    var s = [];
    if (options.data) {
      if (Array.isArray(options.data)) {
        // Add op_return
        s.push(opcode);
        options.data.forEach(function (item) {
          // add push data

          if (/^0x/i.test(item)) {
            // ex: 0x6d02
            s.push(Buffer.from(item.slice(2), "hex"))
          } else {
            // ex: "hello"
            s.push(Buffer.from(item))
          }
        })
      } else if (typeof options.data === 'string') {
        // Exported transaction 
        //s = bch.Script.fromHex(options.data);
        s = [options.data];
      }
    }
    return s;
  }

  constructor(statusMessageFunction) {
    this.queue = new Array();
    this.isSending = false;
    this.statusMessageFunction=statusMessageFunction;
  }

  queueTransaction(transaction) {
    this.queue.push(transaction);
    this.sendNextTransaction();
  }

  sendNextTransaction() {
    //If the queue has run out of transactions
    if (this.queue.length == 0) {
      this.isSending = false;
      return;
    }

    //If the queue is already sending
    if (this.isSending) {
      return;
    }

    //else
    this.isSending = true;
    this.memberBoxSend(this.queue[0], this.serverResponseFunction);

  }

  updateStatus(message){
    console.log(message);
    if(this.statusMessageFunction == null){
      alert(message);
    }else{
      this.statusMessageFunction(message);
    }
  }

  async serverResponseFunction(err, res, returnObject) {

    //nb this = returnObject;

    //This should check for an error, if there is an error, it should resend, possibly with a delay. 
    //maybe change trx fee if it is a low trx fee error. 

    //Maybe should cease sending if insufficient funds.


    returnObject.isSending = false;
    if (err) {
      console.log(err);
      let errorMessage=err.message;
      returnObject.updateStatus("Error:" + errorMessage);
      
      if (errorMessage.startsWith("Network Error")) { 
        returnObject.updateStatus(errorMessage+" ("+returnObject.queue.length+" Transaction(s) Still Queued, Retry in 5 seconds)");
        await sleep(4000);
        returnObject.updateStatus("Sending Again . . .");
        await sleep(1000);
        returnObject.sendNextTransaction();
        return;
      }

      if (errorMessage.startsWith("100")) { //Covers 1000, 1001, 1002
        returnObject.updateStatus(errorMessage+" Removing Transaction From Queue.");
        returnObject.queue.shift();
        returnObject.sendNextTransaction();
        return;
      }

      if (errorMessage.startsWith("66:")) {
        if(miningFeeMultiplier<5){
          //Insufficient Priority - not enough transaction fee provided. Let's try increasing fee.
          miningFeeMultiplier = miningFeeMultiplier*1.1;
          returnObject.updateStatus("Error: Transaction rejected because fee too low. Increasing and retrying. Surge Pricing now "+Math.round(miningFeeMultiplier*10)/10);
          await sleep(1000);
          returnObject.sendNextTransaction();
          return;
        } 
      }
      alert("There was an error processing the transaction required for this action. Make sure you have sufficient funds in your account and try again. Error:" + errorMessage);
      return;
    }

    if (res.length > 10) {
      returnObject.updateStatus("<a target='blockchair' href='https://blockchair.com/bitcoin-cash/transaction/" + res + "'>txid:" + res + "</a>");
      console.log("https://blockchair.com/bitcoin-cash/transaction/" + res);
      returnObject.queue.shift();
      returnObject.sendNextTransaction();
    } else {
      returnObject.updateStatus(res);
    }
  }


  memberBoxSend(options, callback, returnObject) {

    if (!options.cash || !options.cash.key) {
      callback(new Error("1000:No Private Key, Cannot Make Transaction"), null, this);
      return;
    }


    const Address = BITBOX.Address;
    const ECPair = BITBOX.ECPair;
    const TransactionBuilder = BITBOX.TransactionBuilder;
    const Script = BITBOX.Script;
    const RawTransactions = BITBOX.RawTransactions;


    //Create Keypair
    let keyPair = new ECPair().fromWIF(options.cash.key);
    let thePublicKey = keyPair.getAddress();// BITBOX.ECPair.toLegacyAddress(keyPair);

    let fundsRemaining = 0;
    //Get Unspent Transactions
    (async () => {
      
      let address = new Address();

      let outputInfo=new Array();
      try {
        outputInfo = await address.utxo(thePublicKey);
      } catch(error) {
        callback(error, null, this);
        return;
      }      
      
      //console.log(outputInfo);
      let utxos = outputInfo.utxos;

      //Remove any utxos with less or equal to dust limit, they may be SLP tokens
      for (let i = 0; i < utxos.length; i++) {
        if (utxos[i].satoshis <= DUSTLIMIT) {
          utxos.splice(i, 1);
          i--;
        }
      }

      if (utxos.length == 0) {
        callback(new Error("1001:Insufficient Funds (No Suitable UTXOs)"), null, this);
        return;
      }else{
        this.updateStatus("Received "+utxos.length+" utxo(s) of which "+utxos.length+" are usable.");
      }


      let script = new Script();
      let scriptArray = this._script(script.opcodes.OP_RETURN, options);
      let script2 = script.encode(scriptArray);
      //[script.opcodes.OP_RETURN, Buffer.from(options.data[0], 'hex'), Buffer.from(options.data[1])]);

      let maxNumberOfInputs = utxos.length < MAXPOSSNUMBEROFINPUTS ? utxos.length : MAXPOSSNUMBEROFINPUTS;

      //ESTIMATE TRX FEE REQUIRED
      let changeAmount = 0;
      {
        let transactionBuilder = new TransactionBuilder();
        if (scriptArray.length > 0) {
          transactionBuilder.addOutput(script2, 0);
        }


        //Calculate sum of tx outputs and add inputs
        for (let i = 0; i < maxNumberOfInputs; i++) {
          let originalAmount = utxos[i].satoshis;
          fundsRemaining = fundsRemaining + originalAmount;
          // index of vout
          let vout = utxos[i].vout;
          // txid of vout
          let txid = utxos[i].txid;
          // add input with txid and index of vout
          transactionBuilder.addInput(txid, vout);
        }

        let utxoFunds=fundsRemaining;

        //Add any transactions
        if (options.cash.to && Array.isArray(options.cash.to)) {
          options.cash.to.forEach(
            function (receiver) {
              if (receiver.value >= DUSTLIMIT) {
                fundsRemaining = fundsRemaining - receiver.value;
                transactionBuilder.addOutput(receiver.address, receiver.value);
              }
            })
        }

        //Add funds remaining as change, before trx fee considered
        if (fundsRemaining >= DUSTLIMIT) {
          transactionBuilder.addOutput(thePublicKey, fundsRemaining);
        }

        //Sign inputs
        for (let i = 0; i < maxNumberOfInputs; i++) {
          let originalAmount = utxos[i].satoshis;
          // sign w/ HDNode
          let redeemScript;
          transactionBuilder.sign(i, keyPair, redeemScript, transactionBuilder.hashTypes.SIGHASH_ALL, originalAmount);
        }

        // build tx
        let tx = transactionBuilder.build();
        // output rawhex
        let hex = tx.toHex();
        let transactionSize=tx.byteLength();
        //Add extra satoshis for safety
        let fees=Math.round(transactionSize*miningFeeMultiplier) + extraSatoshis;
        changeAmount = fundsRemaining - fees;
        console.log("TRX size:" + transactionSize);
        console.log("Fees:" + fees);
        //console.log(changeAmount);

        if (changeAmount < 0) {
          callback(new Error("1002: Insufficient Funds. Amount available "+utxoFunds+" in "+maxNumberOfInputs+" UTXOs but " + (fundsRemaining+changeAmount) +" required."), null, this);
          return;
        }
      }

      //CONSTRUCT REAL TRANSACTION
      let transactionBuilder = new TransactionBuilder();
      if (scriptArray.length > 0) {
        transactionBuilder.addOutput(script2, 0);
      }

      //Add any transactions
      if (options.cash.to && Array.isArray(options.cash.to)) {
        options.cash.to.forEach(
          function (receiver) {
            if (receiver.value >= DUSTLIMIT) {
              transactionBuilder.addOutput(receiver.address, receiver.value);
            }
          })
      }

      //Add change last
      if (changeAmount >= DUSTLIMIT) {
        transactionBuilder.addOutput(thePublicKey, changeAmount);
      }

      //Add inputs
      for (let i = 0; i < maxNumberOfInputs; i++) {
        let originalAmount = utxos[i].satoshis;
        // index of vout
        let vout = utxos[i].vout;
        // txid of vout
        let txid = utxos[i].txid;
        // add input with txid and index of vout
        transactionBuilder.addInput(txid, vout);

      }

      //sign inputs

      for (let i = 0; i < maxNumberOfInputs; i++) {
        let originalAmount = utxos[i].satoshis;
        // sign w/ HDNode
        let redeemScript;
        transactionBuilder.sign(i, keyPair, redeemScript, transactionBuilder.hashTypes.SIGHASH_ALL, originalAmount);
      }



      //BROADCAST THE TRANSACTION
      // build tx
      let tx = transactionBuilder.build();
      // output rawhex
      let hex = tx.toHex();
      //console.log(hex);
      //console.log(tx.byteLength());

      // sendRawTransaction to running BCH node
      let rawtransactions = new RawTransactions();
      rawtransactions.sendRawTransaction(hex).then((result) => {
        //console.log(result);
        callback(null, result, this);
      }, (err) => {
        //console.log(err);
        err.message=err.error;
        callback(err, null, this);
      });

    })()
  }
}